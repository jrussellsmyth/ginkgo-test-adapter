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

export class GinkgoTestController {
    controller: vscode.TestController;
    watcher: vscode.FileSystemWatcher;
    itemMeta = new WeakMap<vscode.TestItem, any>();
    context: vscode.ExtensionContext;

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
    buildSuite(  ws: vscode.WorkspaceFolder, report: SuiteJson) {

        //create top-level suite item
        const suiteFilePath = path.isAbsolute(report.SuitePath) ? report.SuitePath : path.join(ws.uri.fsPath, report.SuitePath);
        const suiteLabel = report.SuiteDescription;
        const suiteId = `${suiteFilePath}::${suiteLabel}`;
        let suiteTestItem = this.controller.items.get(suiteId);
        // currently this will always happen as we are only caled from  discoverWorkspace which clears all items first. Future case may try to reuse.
        if (!suiteTestItem) {
            suiteTestItem = this.controller.createTestItem(suiteId, suiteLabel, vscode.Uri.file(suiteFilePath));
            this.controller.items.add(suiteTestItem);
            // spec could be the entire report.. but that could be redundant and unnecessary
            this.itemMeta.set(suiteTestItem, { isSuite: true, focus: suiteLabel, workspaceFolder: ws, file: suiteFilePath, suite: suiteLabel,  spec: undefined } as TestItemMeta);
        }
        suiteTestItem.busy = true;
        // clear existing children - 
        suiteTestItem.children.forEach((c) => suiteTestItem.children.delete(c.id));
        
        // we need to keep track of created container nodes to avoid duplicates
        const rootMap = new Map<string, vscode.TestItem>();

        for (const spec of report.SpecReports) {
            const containerHierarchy: string[] = spec.ContainerHierarchyTexts|| [];
            const locations: any[] = spec.ContainerHierarchyLocations || [];
            const leaf = spec.LeafNodeText  || 'unnamed';
            // create container chain
            let parent = suiteTestItem;
            // iterate containers by index so we can retrieve location
            for (let i = 0; i < containerHierarchy.length; i++) {
                const name = containerHierarchy[i];
                const location = locations[i] || {};
                const file = location.FileName || suiteFilePath;
                const line = location.LineNumber || 1;

                const key = parent.id + '>' + name;
                let node = rootMap.get(key);
                if (!node) {
                    node = this.controller.createTestItem(key, name, vscode.Uri.file( file ));
                    node.range = new vscode.Range(new vscode.Position((line as number) - 1, 0), new vscode.Position((line as number) - 1, 0));
                    this.itemMeta.set(node, { isContainer: true, workspaceFolder: ws, focus: name, file: file, suite: suiteLabel, spec: undefined } as TestItemMeta);
                    parent.children.add(node);
                    rootMap.set(key, node);
                }
                parent = node;
            }

            // create the leaf spec
            const specId = parent.id + '::' + leaf;
            const specLocation = spec.LeafNodeLocation || {};
            const specFile = specLocation.FileName;
            const specLine = specLocation.LineNumber || 1;
            const testItem = this.controller.createTestItem(specId, leaf, vscode.Uri.file( specFile));
            
            testItem.range = new vscode.Range(new vscode.Position((specLine as number) - 1, 0), new vscode.Position((specLine as number) - 1, 0));
            
            parent.children.add(testItem);
            this.itemMeta.set(testItem, 
                { 
                    workspaceFolder: ws, 
                    file: specFile, 
                    suite: suiteLabel, 
                    spec: spec 
                } as TestItemMeta
            );
        }
        suiteTestItem.busy = false;
    }

    findSpecReports(obj: any): any[] {
        const found: any[] = [];
        const visit = (v: any) => {
            if (!v || typeof v !== 'object') {
                return;
            }
            if (Array.isArray(v)) {
                for (const e of v) {
                    visit(e);
                }
                return;
            }
            // common field in ginkgo reports is SpecReports or spec_reports
            for (const k of Object.keys(v)) {
                if (k.toLowerCase().includes('specreport') || k.toLowerCase().includes('specreports')) {
                    const arr = v[k];
                    if (Array.isArray(arr)) {
                        for (const s of arr) {
                            found.push(s);
                        }
                    }
                }
            }
            for (const k of Object.keys(v)) {
                visit(v[k]);
            }
        };
        visit(obj);
        return found;
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
                // Debug not implemented
                run.errored(t, new vscode.TestMessage('Debugging not supported yet'));
                continue;
            }
            await this.executeTestItem(t, run, token);
        }

        run.end();
    }

    async executeTestItem(item: vscode.TestItem, run: vscode.TestRun, token: vscode.CancellationToken) {
        // if this is a container, run children - maybe not, ginko runs suites/files only
        // if (item.children.size > 0) {
        //     const childItems: vscode.TestItem[] = [];
        //     item.children.forEach((c) => childItems.push(c));
        //     await Promise.all(childItems.map((c) => this.executeTestItem(c, run, token)));
        //     return;
        // }

        run.started(item);
        const meta = this.itemMeta.get(item) || {};
        const spec = meta.spec || {};

        const file = spec.LeafNodeLocation?.FileName || '';
        const line = spec.LeafNodeLocation?.LineNumber || 1;

        const cwd = file ? path.dirname(file) : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        const outJson = path.join(cwd || '.', 'ginkgo_run_report.json');
        let args: string[] = [];
        if (meta.isContainer) {
            args = ['run', `--json-report=${outJson}`, `--focus=${meta.focus}`];
        } else {
            args = ['run', `--json-report=${outJson}`, `--focus-file=${file}:${line}`];
        }
        

        // write to the run the exact command being run
        run.appendOutput(`ginkgo ${args.join(' ')}\r\n`);
        const proc = cp.spawn('ginkgo', args, { cwd: cwd || undefined });

        token.onCancellationRequested(() => {
            try { proc.kill(); } catch { }
        });

        proc.stdout.on('data', (c) => {
            // make sure line endings are windows compatible
            const msg = String(c).replace(/\n/g, '\r\n');
            run.appendOutput(msg); 
        });
        proc.stderr.on('data', (c) => {
            const msg = String(c).replace(/\n/g, '\r\n');
            run.appendOutput(msg);
        });

        const exitCode = await new Promise<number>((resolve) => {
            proc.on('close', (code) => resolve(code ?? 0));
        });

        // parse report
        if (fs.existsSync(outJson)) {
            try {
                const raw = fs.readFileSync(outJson, 'utf8');
                const parsed = JSON.parse(raw) as SuiteJson[];;
                // new logic should be
                // * find all leaf nodes in item {actual tests}
                // * check results for each leaf node in SuiteJson
                // mabye we can put the selector in the TestItem metadata during discovery?


                // find spec report matching this item (best-effort)
                const specs = this.findSpecReports(parsed);
                let matched = null;
                for (const s of specs) {
                    const leaf = (s.LeafNodeText ) as string || s.description || '';
                    if (leaf && leaf === item.label) { matched = s; break; }
                }
                if (matched) {
                    const state = matched.State || '';
                    if (state === 'passed' || matched.State === 'passed') { run.passed(item); }
                    else if (state === 'skipped' || state === 'pending') { run.skipped(item); }
                    else { 
                        const msg = (matched.Failure && matched.Failure.Message) || 'Failed';
                        run.failed(item, new vscode.TestMessage(msg)); 
                    }
                
                } else {
                    if (exitCode === 0) { run.passed(item); } else { run.failed(item, new vscode.TestMessage('Failed')); }
                }
            } catch (e) {
                if (exitCode === 0) { run.passed(item); } else { run.failed(item, new vscode.TestMessage('Failed')); }
            }
            try { fs.unlinkSync(outJson); } catch { }
        } else {
            if (exitCode === 0) {
                run.passed(item);
            } else {
                run.failed(item, new vscode.TestMessage('Failed'));
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
