import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

type SuiteEntry = { file: string; suite: string; bootstrap: string };

type TestItemMeta = {
    isSuite?: boolean;
    isContainer?: boolean;
    workspaceFolder: vscode.WorkspaceFolder;
    file: string;
    suite: string;
    bootstrap: string;
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
        this.controller.items.forEach((i) => this.controller.items.delete(i.id));
        await this.discoverWorkspace();
    }

    // discover suites in all workspace folders
    async discoverWorkspace() {
        const workspaceFolders = vscode.workspace.workspaceFolders || [];
        for (const ws of workspaceFolders) {
            // ask go helper for suites in this workspace
            const suites = await this.runGoHelper(this.context, ws.uri.fsPath);
            for (const s of suites) {
                    const id = `${s.file}::${s.bootstrap}`;
                    const label = `${s.suite}`;
                    const item = this.controller.createTestItem(id, label, vscode.Uri.file(path.join(ws.uri.fsPath, s.file)));
                this.controller.items.add(item);
                    this.itemMeta.set(item, { isSuite: true, workspaceFolder: ws, file: s.file, suite: s.suite, bootstrap: s.bootstrap, spec: undefined } as TestItemMeta);

                // populate children by running a dry-run for this suite
                this.populateSuiteChildren(item, ws);
            }
        }
    }

    async discoverFile(item: vscode.TestItem) {
        // legacy per-file discovery is no longer used; we populate suites in discoverWorkspace
    }

    async populateSuiteChildren(suiteItem: vscode.TestItem, ws: vscode.WorkspaceFolder) {
        const meta = this.itemMeta.get(suiteItem);
        if (!meta) {
            return;
        }
        const file = meta.file as string;
        const suite = meta.suite as string;
        const bootstrap = meta.bootstrap as string;
        const cwd = ws.uri.fsPath;
        const outJson = path.join(cwd, `ginkgo_discovery_${bootstrap}.json`);
        const args = ['run', '--dry-run', `--json-report=${outJson}`, '--', `-test.run=^${bootstrap}$`];
        try {
            await this.execProcess('ginkgo', args, { cwd });
        } catch (e) {
            // continue
        }
        if (fs.existsSync(outJson)) {
            const raw = fs.readFileSync(outJson, 'utf8');
            try {
                const parsed = JSON.parse(raw);
                this.buildTestTreeFromReport(suiteItem, parsed, ws);
            } catch (e) {}
            try { fs.unlinkSync(outJson); } catch {}
        }
    }

    // best-effort parser: look for spec reports and their container hierarchies
    buildTestTreeFromReport(parentTestItem: vscode.TestItem, report: any, ws: vscode.WorkspaceFolder) {
        // clear existing children
        parentTestItem.children.forEach((c) => parentTestItem.children.delete(c.id));

        const parentMeta = this.itemMeta.get(parentTestItem);

        const specs = this.findSpecReports(report);
        const rootMap = new Map<string, vscode.TestItem>();

        for (const spec of specs) {
            const containerHierarchy: string[] = spec.ContainerHierarchyTexts|| [];
            const locations: any[] = spec.ContainerHierarchyLocations || [];
            const leaf = spec.LeafNodeText  || 'unnamed';
            // create container chain
            let parent = parentTestItem;
            // iterate containers by index so we can retrieve location
            for (let i = 0; i < containerHierarchy.length; i++) {
                const name = containerHierarchy[i];
                const location = locations[i] || {};
                const file = location.FileName || parentMeta?.file;
                const line = location.LineNumber || 1;

                const key = parent.id + '>' + name;
                let node = rootMap.get(key);
                if (!node) {
                    node = this.controller.createTestItem(key, name, vscode.Uri.file( file ));
                    node.range = new vscode.Range(new vscode.Position((line as number) - 1, 0), new vscode.Position((line as number) - 1, 0));
                    this.itemMeta.set(node, { isContainer: true, workspaceFolder: ws, file: file, suite: parentMeta?.suite, bootstrap: parentMeta?.bootstrap, spec: undefined } as TestItemMeta);
                    parent.children.add(node);
                    rootMap.set(key, node);
                }
                parent = node;
            }

            // create the leaf spec
            const specId = parent.id + '::' + leaf;
            const specLocation = spec.LeafNodeLocation || {};
            const specFile = specLocation.FileName || parentMeta?.file;
            const specLine = specLocation.LineNumber || 1;
            const testItem = this.controller.createTestItem(specId, leaf, vscode.Uri.file( specFile));
            
            testItem.range = new vscode.Range(new vscode.Position((specLine as number) - 1, 0), new vscode.Position((specLine as number) - 1, 0));
            
            parent.children.add(testItem);
            this.itemMeta.set(testItem, { workspaceFolder: ws, file: specFile
                , suite: parentMeta?.suite, bootstrap: parentMeta?.bootstrap, spec: spec } as TestItemMeta);
        }
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
        if (item.children.size > 0) {
            item.children.forEach((c) => this.executeTestItem(c, run, token));
            return;
        }

        run.started(item);
        const meta = this.itemMeta.get(item) || {};
        const spec = meta.spec || {};

        var location = meta.isContainer ? spec.ContainerHierarchyLocations?.[spec.ContainerHierarchyLocations.length -1] : spec.LeafNodeLocation;
        const file = spec.LeafNodeLocation?.FileName || '';
        const line = spec.LeafNodeLocation?.LineNumber || 1;

        const cwd = file ? path.dirname(file) : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        const outJson = path.join(cwd || '.', 'ginkgo_run_report.json');
        const args = ['run', `--json-report=${outJson}`, `--focus-file=${file}:${line}`];

        const proc = cp.spawn('ginkgo', args, { cwd: cwd || undefined });

        token.onCancellationRequested(() => {
            try { proc.kill(); } catch { }
        });

        proc.stdout.on('data', (c) => run.appendOutput(String(c)));
        proc.stderr.on('data', (c) => run.appendOutput(String(c)));

        const exitCode = await new Promise<number>((resolve) => {
            proc.on('close', (code) => resolve(code ?? 0));
        });

        // parse report
        if (fs.existsSync(outJson)) {
            try {
                const raw = fs.readFileSync(outJson, 'utf8');
                const parsed = JSON.parse(raw);
                // find spec report matching this item (best-effort)
                const specs = this.findSpecReports(parsed);
                let matched = null;
                for (const s of specs) {
                    const leaf = (s.LeafNodeText || s.leafNodeText || s.Text || s.LeafText || s.leafText) as string || s.description || '';
                    if (leaf && leaf === item.label) { matched = s; break; }
                }
                if (matched) {
                    const state = matched.State || matched.state || matched.SpecState || matched.specState || '';
                    if (state === 'passed' || matched.State === 'passed') { run.passed(item); }
                    else if (state === 'skipped' || state === 'pending') { run.skipped(item); }
                    else { run.failed(item, new vscode.TestMessage('Failed')); }
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

    runGoHelper(context: vscode.ExtensionContext, workspaceRoot: string): Promise<SuiteEntry[]> {
        return new Promise((resolve) => {
            const helperSourcePath = path.join(context.extensionPath, 'helpers', 'discover_suites.go');

            // prefer a prebuilt binary in dist/<platform>-<arch>/discover_suites
            const platform = process.platform; // 'linux'|'darwin'|'win32'
            const arch = process.arch; // 'x64'|'arm64' etc
            const archMap: { [k: string]: string } = { x64: 'amd64', arm64: 'arm64' };
            const archName = archMap[arch] || arch;
            const platName = platform === 'win32' ? 'windows' : platform;
            const exeName = platform === 'win32' ? 'discover_suites.exe' : 'discover_suites';
            const binaryPath = path.join(context.extensionPath, 'dist', `${platName}-${archName}`, exeName);

            let proc: cp.ChildProcessWithoutNullStreams;
            if (fs.existsSync(binaryPath)) {
                const args = ['-dir', workspaceRoot];
                proc = cp.spawn(binaryPath, args, { cwd: workspaceRoot });
            } else if (fs.existsSync(helperSourcePath)) {
                const args = ['run', helperSourcePath, '-dir', workspaceRoot];
                proc = cp.spawn('go', args, { cwd: workspaceRoot });
            } else {
                console.error('discover_suites helper not found (no binary and no source)');
                resolve([]);
                return;
            }
            let out = '';
            proc.stdout.on('data', (c) => out += String(c));
            proc.stderr.on('data', (c) => console.error(String(c)));
            proc.on('close', () => {
                try {
                    const parsed = JSON.parse(out || '[]');
                    resolve(parsed as SuiteEntry[]);
                } catch (e) {
                    resolve([]);
                }
            });
        });
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
