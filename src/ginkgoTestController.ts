import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// should match the struct returned by helpers/discover_suites.go
// type SuiteEntry = { 
//     file: string; 
//     line: number; 
//     column?: number; 
//     suite: string; 
//     entrypoint: string 
// };

type SuiteJson = {
        SuitePath: string;
        SuiteDescription: string;
        SpecReports: SpecReport[];
    };
type SpecReport = {
        ContainerHierarchyTexts?: string[]; 
        ContainerHierarchyLocations?: any[];
        LeafNodeText?: string;
        LeafNodeLocation?: any;
        State?: string;
        Failure?: { Message: string };
    };
type TestItemMeta = {
    isSuite?: boolean;
    isContainer?: boolean;
    focus?: string;
    workspaceFolder: vscode.WorkspaceFolder;
    file: string;
    line: number;
    column?: number;
    suite: string;
    spec?: any;
};

type FullTestItemMeta = {
    type: 'suite'|'container'|'leaf';
    suiteKey: string;
    suitePath: string;
    itemLabel?: string;
    containerPath?: string[];
    file?: string;
    line?: number;
    leafText?: string;
    leafKey?: string;
    fallbackLeafKey?: string;
    containerKey?: string;
    descendantLeafKeys?: Set<string>;
}

export class GinkgoTestController {
    controller: vscode.TestController;
    watcher: vscode.FileSystemWatcher;
    itemMeta = new WeakMap<vscode.TestItem, FullTestItemMeta | any>();
    // reverse lookup maps
    leafKeyToTestItem = new Map<string, vscode.TestItem>();
    containerKeyToLeafKeys = new Map<string, Set<string>>();
    context: vscode.ExtensionContext;
    onDidDiscoverTests?: () => void;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.controller = vscode.tests.createTestController('ginkgo', 'Ginkgo');

        this.controller.resolveHandler = async (item) => {
            if (!item) {
                // root: discover workspace packages with *_test.go
                await this.discoverWorkspace();
                return;
            }

            // If a file item, run bootstrap discovery for that file and populate children
            // if (item.uri && item.uri.fsPath.endsWith('_test.go')) {
            //     await this.discoverFile(item);
            // }
        };

        this.controller.createRunProfile('Run', vscode.TestRunProfileKind.Run, this.runHandler.bind(this));
        this.controller.createRunProfile('Debug', vscode.TestRunProfileKind.Debug, this.runHandler.bind(this), true);

        this.watcher = vscode.workspace.createFileSystemWatcher('**/*_test.go');
        this.watcher.onDidChange((uri) => this.onTestsChanged(uri));
        this.watcher.onDidCreate((uri) => this.onTestsChanged(uri));
        this.watcher.onDidDelete((uri) => this.onTestsChanged(uri));

        context.subscriptions.push(this.controller, this.watcher);
    }

    dispose(): any {
        try { this.watcher.dispose(); } catch { }
        try { this.controller.dispose(); } catch { }
    }

    async onTestsChanged(uri: vscode.Uri) {
        // simple approach: clear root and re-discover
        // future may use url to find and update specific items
        if (this.controller?.resolveHandler) {
            await this.controller.resolveHandler(undefined);
        }
    }

    // discover suites in all workspace folders
    async discoverWorkspace() {
        this.controller.items.forEach((i) => this.controller.items.delete(i.id));
        const workspaceFolders = vscode.workspace.workspaceFolders || [];
        for (const ws of workspaceFolders) {
            this.loadWorkspaceTests(ws);
        }
        // Notify that tests have been discovered
        if (this.onDidDiscoverTests) {
            this.onDidDiscoverTests();
        }
    }

    async discoverFile(item: vscode.TestItem) {
        // legacy per-file discovery is no longer used; we populate suites in discoverWorkspace
    }

    // run ginkgo dry-run from the entrypoint to build the suite tree
    async loadWorkspaceTests(ws: vscode.WorkspaceFolder) {

        const cwd = ws.uri.fsPath;
        const outJson = path.join(cwd, `ginkgo_discovery.json`);
        const args = ['run', '--dry-run', `--json-report=${outJson}`, '-r'];
        try {
            await this.execProcess('ginkgo', args, { cwd });
        } catch (e) {
            // continue
            // improve error handling later
        }
        if (fs.existsSync(outJson)) {
            const raw = fs.readFileSync(outJson, 'utf8');
            try {
                const suiteReports = JSON.parse(raw) as SuiteJson[];
                for (const suiteReport of suiteReports) 
                {
                    this.buildSuite(ws, suiteReport);
                }
            } catch (e) {}
            try { fs.unlinkSync(outJson); } catch {}
        }
    }
    // best-effort parser: look for spec reports and their container hierarchies
    buildSuite(ws: vscode.WorkspaceFolder, report: SuiteJson) {

        // create top-level suite item
        const suiteFilePath = path.isAbsolute(report.SuitePath) ? report.SuitePath : path.join(ws.uri.fsPath, report.SuitePath);
        const suiteLabel = report.SuiteDescription;
        const suiteId = `${suiteFilePath}::${suiteLabel}`;
        const suiteKey = this.makeSuiteKey(report.SuitePath);
        let suiteTestItem = this.controller.items.get(suiteId);
        if (!suiteTestItem) {
            suiteTestItem = this.controller.createTestItem(suiteId, suiteLabel, vscode.Uri.file(suiteFilePath));
            suiteTestItem.range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
            this.controller.items.add(suiteTestItem);
            this.itemMeta.set(suiteTestItem, { type: 'suite', suiteKey, suitePath: suiteFilePath, itemLabel: suiteLabel, descendantLeafKeys: new Set<string>() } as FullTestItemMeta);
        }
        suiteTestItem.busy = true;
        suiteTestItem.children.forEach((c) => suiteTestItem.children.delete(c.id));

        const rootMap = new Map<string, vscode.TestItem>();

        for (const spec of report.SpecReports) {
            const containerHierarchy: string[] = spec.ContainerHierarchyTexts || [];
            const locations: any[] = spec.ContainerHierarchyLocations || [];
            const leaf = spec.LeafNodeText || 'unnamed';
            const containerPath: string[] = [];

            let parent: vscode.TestItem | undefined = suiteTestItem;
            for (let i = 0; i < containerHierarchy.length; i++) {
                const name = containerHierarchy[i];
                const location = locations[i] || {};
                const file = location.FileName || suiteFilePath;
                const line = location.LineNumber || 1;

                const containerId = parent.id + '::' + name;
                let node = rootMap.get(containerId);
                containerPath.push(name);
                if (!node) {
                    node = this.controller.createTestItem(containerId, name, vscode.Uri.file(file));
                    node.range = new vscode.Range(new vscode.Position((line as number) - 1, 0), new vscode.Position((line as number) - 1, 0));
                    const containerKey = this.makeContainerKey(suiteKey, containerPath);
                    this.itemMeta.set(node, { type: 'container', itemLabel: name, suiteKey, suitePath: suiteFilePath, containerPath: [...containerPath], file, line, containerKey, descendantLeafKeys: new Set<string>() } as FullTestItemMeta);
                    if (!this.containerKeyToLeafKeys.has(containerKey)) {this.containerKeyToLeafKeys.set(containerKey, new Set<string>());}
                    parent.children.add(node);
                    rootMap.set(containerId, node);
                }
                parent = node;
            }

            // create the leaf spec
            const specId = parent.id + '::' + leaf;
            const specLocation = spec.LeafNodeLocation || {};
            const specFile = specLocation.FileName || suiteFilePath;
            const specLine = specLocation.LineNumber || 1;
            const testItem = this.controller.createTestItem(specId, leaf, vscode.Uri.file(specFile));
            testItem.range = new vscode.Range(new vscode.Position((specLine as number) - 1, 0), new vscode.Position((specLine as number) - 1, 0));
            parent.children.add(testItem);

            // compute keys and store meta
            const leafKey = this.makeLeafKey(specFile, specLine, suiteKey, containerPath, leaf);
            const fallbackLeafKey = this.makeFallbackLeafKey(suiteKey, containerPath, leaf);
            this.itemMeta.set(testItem, { type: 'leaf', itemLabel: leaf, suiteKey, suitePath: suiteFilePath, containerPath: [...containerPath], file: specFile, line: specLine, leafText: leaf, leafKey, fallbackLeafKey } as FullTestItemMeta);
            if (!this.leafKeyToTestItem.has(leafKey)) {this.leafKeyToTestItem.set(leafKey, testItem);}
            else {this.leafKeyToTestItem.set(fallbackLeafKey, testItem);}

            // register leafKey with ancestor containers and suite
            let ancestor: vscode.TestItem | undefined = parent;
            while (ancestor) {
                const m = this.itemMeta.get(ancestor) as FullTestItemMeta | undefined;
                if (m) {
                    if (!m.descendantLeafKeys) {m.descendantLeafKeys = new Set<string>();}
                    m.descendantLeafKeys.add(leafKey);
                    if (m.containerKey) {
                        const set = this.containerKeyToLeafKeys.get(m.containerKey)!;
                        set.add(leafKey);
                    }
                }
                if (ancestor === suiteTestItem) {break;}
                const parentId = ancestor.id.substring(0, ancestor.id.lastIndexOf('::'));
                ancestor = parentId ? this.findTestItemByIdPrefix(parentId) : undefined;
            }
        }
        suiteTestItem.busy = false;
    }


    // helper to find test item by id prefix (exact or child)
    findTestItemByIdPrefix(prefix: string): vscode.TestItem | undefined {
        const exact = this.controller.items.get(prefix);
        if (exact) {return exact;}
        for (const [, item] of this.controller.items) {
            const child = item.children.get(prefix);
            if (child) {return child;}
        }
        return undefined;
    }

    // key helpers
    makeSuiteKey(suitePath: string) {
        return path.resolve(suitePath);
    }
    makeContainerKey(suiteKey: string, containerPath: string[]) {
        return `${suiteKey}::C::${containerPath.map((s)=>s.replace(/::/g,'\\::')).join('::')}`;
    }
    makeLeafKey(file?: string, line?: number, suiteKey?: string, containerPath: string[] = [], leafText?: string) {
        if (file && line) {
            return `${path.resolve(file)}:${line}`;
        }
        return this.makeFallbackLeafKey(suiteKey || '.', containerPath, leafText);
    }
    makeFallbackLeafKey(suiteKey: string, containerPath: string[], leafText?: string) {
        return `${suiteKey}::L::${containerPath.map((s)=>s.replace(/::/g,'\\::')).join('::')}::${leafText || ''}`;
    }

    async runHandler(request: vscode.TestRunRequest, token: vscode.CancellationToken) {
        const run = this.controller.createTestRun(request);

        const toRun: vscode.TestItem[] = [];
        if (request.include) {
            request.include.forEach((t) => toRun.push(t));
        } else {
            this.controller.items.forEach((i) => toRun.push(i));
        }

        for (const t of toRun) {
            if (request.profile?.kind === vscode.TestRunProfileKind.Debug) {
                await this.executeTestItem(t, run, token, true);
            } else {
                await this.executeTestItem(t, run, token);
            }
        }

        run.end();
    }

    async executeTestItem(item: vscode.TestItem, run: vscode.TestRun, token: vscode.CancellationToken, isDebug?: boolean) {
        run.started(item);

        const meta = this.itemMeta.get(item) as FullTestItemMeta | any;

        const wf = item.uri ? vscode.workspace.getWorkspaceFolder(item.uri) : undefined;
        const cwd = meta?.file ? path.dirname(meta.file) : (wf?.uri.fsPath || meta?.suitePath || process.cwd());

        const outJson = path.join(cwd || '.', `ginkgo_run_report_${Date.now()}_${process.pid}.json`);
        let stdout = '';
        let exitCode = 0;
        let args: string[] = [];
        let argPrefix = '--';
        
        if (isDebug) { argPrefix = '-ginkgo.'; }
        if (meta?.type === 'container') {
            // prefer running the container by the file:line available on the container node
            if (meta.file && meta.line) {
                args = [`${argPrefix}json-report=${outJson}`, `${argPrefix}focus-file=${meta.file}:${meta.line}`];
            } else {
                const focus = meta.containerPath?.join('::') || meta.leafText || '';
                args = [`${argPrefix}json-report=${outJson}`, `${argPrefix}focus=${focus}`];
            }
        } else if (meta?.type === 'leaf') {
            args = [ `${argPrefix}json-report=${outJson}`, `${argPrefix}focus-file=${meta.file}:${meta.line}`];
        } else {
            args = [ `${argPrefix}json-report=${outJson}`, '-r'];
        }

        if (isDebug) {
            const dbgName = `Ginkgo Debug ${Date.now()}`;
            const binaryBase = `ginkgo_test_bin_${Date.now()}_${process.pid}`;
            const binaryName = process.platform === 'win32' ? `${binaryBase}.exe` : binaryBase;

            // build the test binary in the workspace (go test -c -o <binary>)
            try {
                
                const debugConfig: any = {
                    name: dbgName,
                    type: 'go',
                    request: 'launch',
                    mode: 'auto',
                    program: meta.file,
                    args: args,
                    cwd: cwd || undefined,
                };
                run.appendOutput(`debugging: ${meta.label} ${args.join(' ')}\r\n\r\n`);

                const started = await vscode.debug.startDebugging(wf, debugConfig);
                if (!started) {
                    run.appendOutput('Debug session failed to start\r\n');
                    return;
                }
            } catch (e) {
                run.appendOutput('Build or debug failed: ' + String(e) + '\r\n');
                return;
            } 
        } else {
           
               
            args = ['run', ...args];
            run.appendOutput(`ginkgo ${args.join(' ')}\r\n\r\n`);
            const proc = cp.spawn('ginkgo', args, { cwd: cwd || undefined });
            token.onCancellationRequested(() => { try { proc.kill(); } catch {} });

            proc.stdout.on('data', (c) => { const msg = String(c); stdout += msg; run.appendOutput(msg.replace(/\n/g,'\r\n')); });
            proc.stderr.on('data', (c) => run.appendOutput(String(c).replace(/\n/g,'\r\n')));

            exitCode = await new Promise<number>((resolve) => proc.on('close', (code) => resolve(code ?? 0)));
        }

        const parsedSpecMap = new Map<string, any>();
        try {
            if (fs.existsSync(outJson)) {
                const raw = fs.readFileSync(outJson, 'utf8');
                const parsed = JSON.parse(raw) as SuiteJson[];
                for (const suite of parsed) {
                    const suiteKey = this.makeSuiteKey(suite.SuitePath);
                    for (const s of suite.SpecReports) {
                        const containers = s.ContainerHierarchyTexts || [];
                        const loc = s.LeafNodeLocation || {};
                        const pk = this.makeLeafKey(loc.FileName, loc.LineNumber, suiteKey, containers, s.LeafNodeText);
                        parsedSpecMap.set(pk, s);
                        const fk = this.makeFallbackLeafKey(suiteKey, containers, s.LeafNodeText);
                        if (!parsedSpecMap.has(fk)) {parsedSpecMap.set(fk, s);}
                    }
                }
            } else {
                run.appendOutput('No ginkgo JSON report found\r\n');
            }
        } catch (e) {
            run.appendOutput('Failed parsing ginkgo JSON: ' + String(e) + '\r\n');
        } finally {
            try { fs.unlinkSync(outJson); } catch {}
        }

        const applySpecToItem = (ti: vscode.TestItem, s: any) => {
            const state = s.State || '';
            if (state === 'passed') { run.passed(ti); return; }
            if (state === 'skipped' || state === 'pending') { run.skipped(ti); return; }
            const msg = (s.Failure && s.Failure.Message) || 'Failed';
            run.failed(ti, new vscode.TestMessage(msg));
        };

        if (meta?.type === 'leaf') {
            const leafKey = meta.leafKey || this.makeLeafKey(meta.file, meta.line, meta.suiteKey, meta.containerPath || [], meta.leafText);
            const s = parsedSpecMap.get(leafKey) || parsedSpecMap.get(meta.fallbackLeafKey || '');
            if (s) {
                const mapped = this.leafKeyToTestItem.get(leafKey) || this.leafKeyToTestItem.get(meta.fallbackLeafKey || leafKey) || item;
                applySpecToItem(mapped, s);
            } else {
                if (exitCode === 0) {run.passed(item);} else {run.failed(item, new vscode.TestMessage('Failed'));}
            }
            return;
        }

        if (meta?.type === 'container' || meta?.type === 'suite') {
            const descendants = meta.descendantLeafKeys || (meta.containerKey ? this.containerKeyToLeafKeys.get(meta.containerKey) || new Set<string>() : new Set<string>());
            let aggState: 'failed' | 'passed' | 'skipped' = 'skipped';
            let anyFound = false;
            for (const lk of descendants) {
                const mappedItem = this.leafKeyToTestItem.get(lk);
                const s = parsedSpecMap.get(lk);
                if (mappedItem && s) {
                    anyFound = true;
                    applySpecToItem(mappedItem, s);
                    const st = s.State || '';
                    if (st === 'failed') {aggState = 'failed';}
                    else if (st === 'passed' && aggState !== 'failed') {aggState = 'passed';}
                } else if (mappedItem) {
                    anyFound = true;
                    if (exitCode === 0) { run.passed(mappedItem); if (aggState !== 'failed') {aggState = 'passed';} }
                    else { run.failed(mappedItem, new vscode.TestMessage('Failed')); aggState = 'failed'; }
                }
            }
            if (anyFound) {
                if (aggState === 'failed') {run.failed(item, new vscode.TestMessage('One or more child tests failed'));}
                else if (aggState === 'passed') {run.passed(item);}
                else {run.skipped(item);}
            } else {
                if (exitCode === 0) {run.passed(item);} else {run.failed(item, new vscode.TestMessage('Failed'));}
            }
            return;
        }

        for (const [k, ti] of this.leafKeyToTestItem.entries()) {
            if (ti.label === item.label) {
                const s = parsedSpecMap.get(k);
                if (s) {applySpecToItem(ti, s);}
                else if (exitCode === 0) {run.passed(ti);} else {run.failed(ti, new vscode.TestMessage('Failed'));}
            }
        }
    }

    execProcess(cmd: string, args: string[], opts: cp.SpawnOptions = {}): Promise<void> {
        return new Promise((resolve, reject) => {
            const p = cp.spawn(cmd, args, opts);
            p.stdout?.on('data', (c) => { });
            p.stderr?.on('data', (c) => { });
            p.on('error', (e) => reject(e));
            p.on('close', (code) => { 
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error('non-zero'));
                }
            });
        });
    }
}
