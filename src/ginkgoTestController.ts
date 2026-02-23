import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { constants } from './constants';


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
    type: 'suite' | 'container' | 'leaf';
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
    runProfile: vscode.TestRunProfile;
    debugProfile: vscode.TestRunProfile;
    // debounce / single-flight state for file-change triggered discovery
    private _changeDebounceTimer: ReturnType<typeof setTimeout> | undefined = undefined;
    private _discoveryInProgress = false;
    private _discoveryPending = false;

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

        this.runProfile = this.controller.createRunProfile('Run', vscode.TestRunProfileKind.Run, this.runHandler.bind(this));
        this.debugProfile = this.controller.createRunProfile('Debug', vscode.TestRunProfileKind.Debug, this.runHandler.bind(this), true);

        this.watcher = vscode.workspace.createFileSystemWatcher('**/*_test.go');
        this.watcher.onDidChange((uri) => this.onTestsChanged(uri));
        this.watcher.onDidCreate((uri) => this.onTestsChanged(uri));
        this.watcher.onDidDelete((uri) => this.onTestsChanged(uri));

        context.subscriptions.push(this.controller, this.watcher);
    }

    // Configuration helpers
    getGinkgoPath(): string {
        const config = vscode.workspace.getConfiguration(constants.configurationSection);
        return config.get<string>('ginkgoPath', constants.defaultGinkgoPath);
    }

    getEnvironmentVariables(): Record<string, string> {
        const config = vscode.workspace.getConfiguration(constants.configurationSection);
        return config.get<Record<string, string>>('environmentVariables', constants.defaultEnvironmentVariables);
    }

    getBuildTags(): string[] {
        const config = vscode.workspace.getConfiguration(constants.configurationSection);
        return config.get<string[]>('buildTags', constants.defaultBuildTags);
    }

    dispose(): any {
        if (this._changeDebounceTimer !== undefined) {
            clearTimeout(this._changeDebounceTimer);
            this._changeDebounceTimer = undefined;
        }
        try { this.watcher.dispose(); } catch { }
        try { this.controller.dispose(); } catch { }
    }

    onTestsChanged(_uri: vscode.Uri) {
        // Debounce: reset the timer on every event so that a burst of rapid saves
        // (auto-save, formatters, etc.) collapses into a single discovery run.
        if (this._changeDebounceTimer !== undefined) {
            clearTimeout(this._changeDebounceTimer);
        }
        this._changeDebounceTimer = setTimeout(() => {
            this._changeDebounceTimer = undefined;
            this._scheduleDiscovery();
        }, 500);
    }

    private _scheduleDiscovery() {
        if (this._discoveryInProgress) {
            // A run is already in flight — record that another pass is needed once
            // it finishes so we never drop a change that arrived mid-run.
            this._discoveryPending = true;
            return;
        }
        this._runDiscovery();
    }

    private async _runDiscovery() {
        this._discoveryInProgress = true;
        this._discoveryPending = false;
        try {
            await this.discoverWorkspace();
        } finally {
            this._discoveryInProgress = false;
            // If a change arrived while we were running, do one more pass.
            if (this._discoveryPending) {
                this._discoveryPending = false;
                this._runDiscovery();
            }
        }
    }

    // discover suites in all workspace folders
    async discoverWorkspace() {
        // Instead of clearing all items first, we'll track which suites we've seen
        // and only remove ones that no longer exist after discovery
        const seenSuiteIds = new Set<string>();
        const workspaceFolders = vscode.workspace.workspaceFolders || [];

        // Mark all existing suites as busy during discovery
        this.controller.items.forEach((i) => {
            i.busy = true;
        });

        // Build fresh lookup maps so stale entries are never retained across discoveries
        const tempLeafKeyToTestItem = new Map<string, vscode.TestItem>();
        const tempContainerKeyToLeafKeys = new Map<string, Set<string>>();

        for (const ws of workspaceFolders) {
            const discoveredIds = await this.loadWorkspaceTests(ws, tempLeafKeyToTestItem, tempContainerKeyToLeafKeys);
            discoveredIds.forEach(id => seenSuiteIds.add(id));
        }

        // Atomically replace the member lookup maps with the freshly built ones
        this.leafKeyToTestItem = tempLeafKeyToTestItem;
        this.containerKeyToLeafKeys = tempContainerKeyToLeafKeys;

        // Remove suites that were not discovered
        const toDelete: string[] = [];
        this.controller.items.forEach((i) => {
            if (!seenSuiteIds.has(i.id)) {
                toDelete.push(i.id);
            } else {
                i.busy = false;
            }
        });
        toDelete.forEach(id => this.controller.items.delete(id));

        // Notify that tests have been discovered
        if (this.onDidDiscoverTests) {
            this.onDidDiscoverTests();
        }
    }

    // run ginkgo dry-run from the entrypoint to build the suite tree
    async loadWorkspaceTests(ws: vscode.WorkspaceFolder, leafKeyToTestItem: Map<string, vscode.TestItem>, containerKeyToLeafKeys: Map<string, Set<string>>): Promise<string[]> {
        const discoveredSuiteIds: string[] = [];

        const cwd = ws.uri.fsPath;
        const outJson = path.join(cwd, `ginkgo_discovery.json`);
        const args = ['run', '--dry-run', `--json-report=${outJson}`, '-r'];

        // Add build tags if configured
        const buildTags = this.getBuildTags();
        if (buildTags.length > 0) {
            args.push(`--tags=${buildTags.join(',')}`);
        }

        try {
            await this.execProcess(this.getGinkgoPath(), args, { cwd });
        } catch (e) {
            // continue
            // improve error handling later
        }
        if (fs.existsSync(outJson)) {
            const raw = fs.readFileSync(outJson, 'utf8');
            try {
                const suiteReports = JSON.parse(raw) as SuiteJson[];
                for (const suiteReport of suiteReports) {
                    const suiteId = this.buildSuite(ws, suiteReport, leafKeyToTestItem, containerKeyToLeafKeys);
                    if (suiteId) {
                        discoveredSuiteIds.push(suiteId);
                    }
                }
            } catch (e) { }
            try { fs.unlinkSync(outJson); } catch { }
        }
        return discoveredSuiteIds;
    }
    // best-effort parser: look for spec reports and their container hierarchies
    buildSuite(ws: vscode.WorkspaceFolder, report: SuiteJson, leafKeyToTestItem: Map<string, vscode.TestItem>, containerKeyToLeafKeys: Map<string, Set<string>>): string | undefined {

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

        // Build new tree in memory first, then reconcile with existing children
        const newRootMap = new Map<string, vscode.TestItem>();
        const seenChildIds = new Set<string>();

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
                seenChildIds.add(containerId);
                let node = newRootMap.get(containerId);
                containerPath.push(name);
                if (!node) {
                    // Check if node already exists in the current tree
                    node = parent.children.get(containerId);
                    if (!node) {
                        // Create new node
                        node = this.controller.createTestItem(containerId, name, vscode.Uri.file(file));
                        node.range = new vscode.Range(new vscode.Position((line as number) - 1, 0), new vscode.Position((line as number) - 1, 0));
                        const containerKey = this.makeContainerKey(suiteKey, containerPath);
                        this.itemMeta.set(node, { type: 'container', itemLabel: name, suiteKey, suitePath: suiteFilePath, containerPath: [...containerPath], file, line, containerKey, descendantLeafKeys: new Set<string>() } as FullTestItemMeta);
                        if (!containerKeyToLeafKeys.has(containerKey)) { containerKeyToLeafKeys.set(containerKey, new Set<string>()); }
                        parent.children.add(node);
                    } else {
                        // Update existing node metadata
                        const containerKey = this.makeContainerKey(suiteKey, containerPath);
                        this.itemMeta.set(node, { type: 'container', itemLabel: name, suiteKey, suitePath: suiteFilePath, containerPath: [...containerPath], file, line, containerKey, descendantLeafKeys: new Set<string>() } as FullTestItemMeta);
                        if (!containerKeyToLeafKeys.has(containerKey)) { containerKeyToLeafKeys.set(containerKey, new Set<string>()); }
                    }
                    newRootMap.set(containerId, node);
                }
                parent = node;
            }

            // create the leaf spec
            const specId = parent.id + '::' + leaf;
            seenChildIds.add(specId);
            const specLocation = spec.LeafNodeLocation || {};
            const specFile = specLocation.FileName || suiteFilePath;
            const specLine = specLocation.LineNumber || 1;

            let testItem = parent.children.get(specId);
            if (!testItem) {
                // Create new test item
                testItem = this.controller.createTestItem(specId, leaf, vscode.Uri.file(specFile));
                testItem.range = new vscode.Range(new vscode.Position((specLine as number) - 1, 0), new vscode.Position((specLine as number) - 1, 0));
                parent.children.add(testItem);
            } else {
                // Update existing test item's range if needed
                testItem.range = new vscode.Range(new vscode.Position((specLine as number) - 1, 0), new vscode.Position((specLine as number) - 1, 0));
            }

            // compute keys and store meta
            const leafKey = this.makeLeafKey(specFile, specLine, suiteKey, containerPath, leaf);
            const fallbackLeafKey = this.makeFallbackLeafKey(suiteKey, containerPath, leaf);
            this.itemMeta.set(testItem, { type: 'leaf', itemLabel: leaf, suiteKey, suitePath: suiteFilePath, containerPath: [...containerPath], file: specFile, line: specLine, leafText: leaf, leafKey, fallbackLeafKey } as FullTestItemMeta);
            leafKeyToTestItem.set(leafKey, testItem);
            leafKeyToTestItem.set(fallbackLeafKey, testItem);

            // register leafKey with ancestor containers and suite
            let ancestor: vscode.TestItem | undefined = parent;
            while (ancestor) {
                const m = this.itemMeta.get(ancestor) as FullTestItemMeta | undefined;
                if (m) {
                    if (!m.descendantLeafKeys) { m.descendantLeafKeys = new Set<string>(); }
                    m.descendantLeafKeys.add(leafKey);
                    if (m.containerKey) {
                        const set = containerKeyToLeafKeys.get(m.containerKey)!;
                        set.add(leafKey);
                    }
                }
                if (ancestor === suiteTestItem) { break; }
                const parentId = ancestor.id.substring(0, ancestor.id.lastIndexOf('::'));
                ancestor = parentId ? this.findTestItemByIdPrefix(parentId) : undefined;
            }
        }

        // Remove children that no longer exist (recursively)
        this.removeStaleChildren(suiteTestItem, seenChildIds);

        suiteTestItem.busy = false;
        return suiteId;
    }


    // helper to recursively remove stale children not seen in current discovery
    // Note: seenIds contains IDs for all levels of the hierarchy, so we can use it
    // to check at each level whether a child should be kept or removed
    private removeStaleChildren(parent: vscode.TestItem, seenIds: Set<string>) {
        const toDelete: string[] = [];
        parent.children.forEach((child) => {
            if (!seenIds.has(child.id)) {
                toDelete.push(child.id);
            } else {
                // Recursively check children's descendants
                this.removeStaleChildren(child, seenIds);
            }
        });
        toDelete.forEach(id => parent.children.delete(id));
    }

    // helper to find test item by id prefix (exact or child)
    findTestItemByIdPrefix(prefix: string): vscode.TestItem | undefined {
        const exact = this.controller.items.get(prefix);
        if (exact) { return exact; }
        for (const [, item] of this.controller.items) {
            const child = item.children.get(prefix);
            if (child) { return child; }
        }
        return undefined;
    }

    // key helpers
    makeSuiteKey(suitePath: string) {
        return path.resolve(suitePath);
    }
    makeContainerKey(suiteKey: string, containerPath: string[]) {
        return `${suiteKey}::C::${containerPath.map((s) => s.replace(/::/g, '\\::')).join('::')}`;
    }
    makeLeafKey(file?: string, line?: number, suiteKey?: string, containerPath: string[] = [], leafText?: string) {
        if (file && line) {
            return `${path.resolve(file)}:${line}`;
        }
        return this.makeFallbackLeafKey(suiteKey || '.', containerPath, leafText);
    }
    makeFallbackLeafKey(suiteKey: string, containerPath: string[], leafText?: string) {
        return `${suiteKey}::L::${containerPath.map((s) => s.replace(/::/g, '\\::')).join('::')}::${leafText || ''}`;
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
            args = [`${argPrefix}json-report=${outJson}`, `${argPrefix}focus-file=${meta.file}:${meta.line}`];
        } else {
            args = [`${argPrefix}json-report=${outJson}`, '-r'];
        }

        // Get build tags for later use
        const buildTags = this.getBuildTags();

        if (isDebug) {
            const dbgName = `Ginkgo Debug ${Date.now()}`;
            try {

                // Get environment variables and merge with current env
                const envVars = this.getEnvironmentVariables();
                const env = { ...process.env, ...envVars };

                const debugConfig: any = {
                    name: dbgName,
                    type: 'go',
                    request: 'launch',
                    mode: 'auto',
                    program: meta.file,
                    args: args,
                    cwd: cwd || undefined,
                    env: env,
                };

                // Add build tags to debug config if specified
                if (buildTags.length > 0) {
                    debugConfig.buildFlags = `-tags=${buildTags.join(',')}`;
                }

                run.appendOutput(`debugging: ${meta.itemLabel || item.label} ${args.join(' ')}\r\n\r\n`);

                const started = await vscode.debug.startDebugging(wf, debugConfig);
                if (!started) {
                    run.appendOutput('Debug session failed to start\r\n');
                    return;
                }

                // Wait for the debug session to terminate before parsing results
                await new Promise<void>((resolve) => {
                    const sub = vscode.debug.onDidTerminateDebugSession((session) => {
                        if (session.name === dbgName) {
                            sub.dispose();
                            resolve();
                        }
                    });
                    token.onCancellationRequested(() => {
                        sub.dispose();
                        resolve();
                        vscode.debug.stopDebugging();
                    });
                });
            } catch (e) {
                run.appendOutput('Build or debug failed: ' + String(e) + '\r\n');
                return;
            }
        } else {


            args = ['run', ...args];

            // Add build tags for non-debug mode
            if (buildTags.length > 0) {
                args.push(`--tags=${buildTags.join(',')}`);
            }

            const ginkgoPath = this.getGinkgoPath();
            run.appendOutput(`${ginkgoPath} ${args.join(' ')}\r\n\r\n`);

            // Get environment variables and merge with current env
            const envVars = this.getEnvironmentVariables();
            const env = { ...process.env, ...envVars };

            const proc = cp.spawn(ginkgoPath, args, { cwd: cwd || undefined, env });
            token.onCancellationRequested(() => { try { proc.kill(); } catch { } });

            proc.stdout.on('data', (c) => { const msg = String(c); run.appendOutput(msg.replace(/\n/g, '\r\n')); });
            proc.stderr.on('data', (c) => run.appendOutput(String(c).replace(/\n/g, '\r\n')));

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
                        if (!parsedSpecMap.has(fk)) { parsedSpecMap.set(fk, s); }
                    }
                }
            } else {
                run.appendOutput('No ginkgo JSON report found\r\n');
            }
        } catch (e) {
            run.appendOutput('Failed parsing ginkgo JSON: ' + String(e) + '\r\n');
        } finally {
            try { fs.unlinkSync(outJson); } catch { }
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
                if (exitCode === 0) { run.passed(item); } else { run.failed(item, new vscode.TestMessage('Failed')); }
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
                    if (st === 'failed') { aggState = 'failed'; }
                    else if (st === 'passed' && aggState !== 'failed') { aggState = 'passed'; }
                } else if (mappedItem) {
                    anyFound = true;
                    if (exitCode === 0) { run.passed(mappedItem); if (aggState !== 'failed') { aggState = 'passed'; } }
                    else { run.failed(mappedItem, new vscode.TestMessage('Failed')); aggState = 'failed'; }
                }
            }
            if (anyFound) {
                if (aggState === 'failed') { run.failed(item, new vscode.TestMessage('One or more child tests failed')); }
                else if (aggState === 'passed') { run.passed(item); }
                else { run.skipped(item); }
            } else {
                if (exitCode === 0) { run.passed(item); } else { run.failed(item, new vscode.TestMessage('Failed')); }
            }
            return;
        }

        for (const [k, ti] of this.leafKeyToTestItem.entries()) {
            if (ti.label === item.label) {
                const s = parsedSpecMap.get(k);
                if (s) { applySpecToItem(ti, s); }
                else if (exitCode === 0) { run.passed(ti); } else { run.failed(ti, new vscode.TestMessage('Failed')); }
            }
        }
    }

    execProcess(cmd: string, args: string[], opts: cp.SpawnOptions = {}): Promise<void> {
        return new Promise((resolve, reject) => {
            // Merge environment variables from config with provided options
            const envVars = this.getEnvironmentVariables();
            const mergedOpts = {
                ...opts,
                env: { ...process.env, ...envVars, ...(opts.env || {}) }
            };

            const p = cp.spawn(cmd, args, mergedOpts);
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
