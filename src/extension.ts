// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { GinkgoTestController } from './ginkgoTestController';

/**
 * Activate the VS Code extension.
 *
 * Logs activation to the console, instantiates the Ginkgo test controller (passing the
 * provided extension context), and registers an example "ginkgo-test-adapter.helloWorld"
 * command that shows an information message. The command's disposable is added to
 * context.subscriptions so it will be cleaned up when the extension is deactivated.
 *
 * @param context - The extension context provided by VS Code, used to register disposables
 *                  and persist extension state across activation sessions.
 */
export function activate(context: vscode.ExtensionContext) {
	console.log('Ginkgo Test Adapter active');

	// start test controller
	const controller = new GinkgoTestController(context);

	context.subscriptions.push(controller);
}

export function deactivate() {}
