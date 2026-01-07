import * as vscode from 'vscode';
import { GinkgoTestController } from './ginkgoTestController';

/**
 * Provides CodeLens for Ginkgo test files to enable "Run Test" and "Debug Test"
 * actions directly in the editor.
 */
export class GinkgoCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

    constructor(private controller: GinkgoTestController) {}

    /**
     * Trigger a refresh of all code lenses
     */
    public refresh(): void {
        this._onDidChangeCodeLenses.fire();
    }

    /**
     * Provide code lenses for a document
     */
    public provideCodeLenses(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
        const codeLenses: vscode.CodeLens[] = [];

        // Only provide code lenses for Go test files
        if (!document.fileName.endsWith('_test.go')) {
            return codeLenses;
        }

        // Find all test items associated with this file
        const testItems = this.findTestItemsForFile(document.uri);

        for (const item of testItems) {
            if (item.range) {
                const range = item.range;
                
                // Create "Run Test" code lens
                const runLens = new vscode.CodeLens(range, {
                    title: '▶ Run Test',
                    command: 'ginkgo-test-adapter.runTest',
                    arguments: [item]
                });
                codeLenses.push(runLens);

                // Create "Debug Test" code lens
                const debugLens = new vscode.CodeLens(range, {
                    title: '🐛 Debug Test',
                    command: 'ginkgo-test-adapter.debugTest',
                    arguments: [item]
                });
                codeLenses.push(debugLens);
            }
        }

        return codeLenses;
    }

    /**
     * Find all test items associated with a given file URI
     */
    private findTestItemsForFile(fileUri: vscode.Uri): vscode.TestItem[] {
        const items: vscode.TestItem[] = [];
        const filePath = fileUri.fsPath;

        // Recursively collect test items from the controller
        const collectItems = (item: vscode.TestItem) => {
            // Check if this item is associated with the file
            if (item.uri && item.uri.fsPath === filePath) {
                const meta = this.controller.itemMeta.get(item);
                // Only add items that have metadata and are not just suites at line 0
                if (meta && meta.type !== 'suite') {
                    items.push(item);
                }
            }
            
            // Recursively check children
            item.children.forEach(child => collectItems(child));
        };

        // Start from root items
        this.controller.controller.items.forEach(item => collectItems(item));

        return items;
    }
}
