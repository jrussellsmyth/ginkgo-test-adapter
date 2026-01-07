import * as assert from 'assert';
import * as vscode from 'vscode';
import { DEFAULT_GINKGO_PATH, DEFAULT_ENVIRONMENT_VARIABLES, DEFAULT_BUILD_TAGS } from '../constants';

suite('Configuration Test Suite', () => {

	test('Default constants are defined correctly', () => {
		assert.strictEqual(DEFAULT_GINKGO_PATH, 'ginkgo');
		assert.deepStrictEqual(DEFAULT_ENVIRONMENT_VARIABLES, {});
		assert.deepStrictEqual(DEFAULT_BUILD_TAGS, []);
	});

	test('Configuration schema exists for ginkgoPath', () => {
		const config = vscode.workspace.getConfiguration('ginkgoTestAdapter');
		const ginkgoPath = config.get<string>('ginkgoPath');
		// Should have a default value
		assert.ok(ginkgoPath !== undefined);
	});

	test('Configuration schema exists for environmentVariables', () => {
		const config = vscode.workspace.getConfiguration('ginkgoTestAdapter');
		const envVars = config.get<Record<string, string>>('environmentVariables');
		// Should have a default value
		assert.ok(envVars !== undefined);
	});

	test('Configuration schema exists for buildTags', () => {
		const config = vscode.workspace.getConfiguration('ginkgoTestAdapter');
		const buildTags = config.get<string[]>('buildTags');
		// Should have a default value
		assert.ok(buildTags !== undefined);
	});
});
