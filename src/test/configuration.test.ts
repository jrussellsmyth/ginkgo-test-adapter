import * as assert from 'assert';
import * as vscode from 'vscode';
import { constants } from '../constants';

suite('Configuration Test Suite', () => {

	test('Default constants are defined correctly', () => {
		assert.strictEqual(constants.DEFAULT_GINKGO_PATH, 'ginkgo');
		assert.deepStrictEqual(constants.DEFAULT_ENVIRONMENT_VARIABLES, {});
		assert.deepStrictEqual(constants.DEFAULT_BUILD_TAGS, []);
		assert.strictEqual(constants.CONFIGURATION_SECTION, 'ginkgoTestAdapter');
	});

	test('Configuration schema exists for ginkgoPath', () => {
		const config = vscode.workspace.getConfiguration(constants.CONFIGURATION_SECTION);
		const ginkgoPath = config.get<string>('ginkgoPath');
		// Should have a default value
		assert.ok(ginkgoPath !== undefined);
	});

	test('Configuration schema exists for environmentVariables', () => {
		const config = vscode.workspace.getConfiguration(constants.CONFIGURATION_SECTION);
		const envVars = config.get<Record<string, string>>('environmentVariables');
		// Should have a default value
		assert.ok(envVars !== undefined);
	});

	test('Configuration schema exists for buildTags', () => {
		const config = vscode.workspace.getConfiguration(constants.CONFIGURATION_SECTION);
		const buildTags = config.get<string[]>('buildTags');
		// Should have a default value
		assert.ok(buildTags !== undefined);
	});
});
