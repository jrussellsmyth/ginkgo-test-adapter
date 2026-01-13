import * as assert from 'assert';
import * as vscode from 'vscode';
import { constants } from '../constants';

suite('Configuration Test Suite', () => {

	test('Default constants are defined correctly', () => {
		assert.strictEqual(constants.defaultGinkgoPath, 'ginkgo');
		assert.deepStrictEqual(constants.defaultEnvironmentVariables, {});
		assert.deepStrictEqual(constants.defaultBuildTags, []);
		assert.strictEqual(constants.configurationSection, 'ginkgoTestAdapter');
	});

	test('Configuration schema exists for ginkgoPath', () => {
		const config = vscode.workspace.getConfiguration(constants.configurationSection);
		const ginkgoPath = config.get<string>('ginkgoPath');
		// Should have a default value
		assert.ok(ginkgoPath !== undefined);
	});

	test('Configuration schema exists for environmentVariables', () => {
		const config = vscode.workspace.getConfiguration(constants.configurationSection);
		const envVars = config.get<Record<string, string>>('environmentVariables');
		// Should have a default value
		assert.ok(envVars !== undefined);
	});

	test('Configuration schema exists for buildTags', () => {
		const config = vscode.workspace.getConfiguration(constants.configurationSection);
		const buildTags = config.get<string[]>('buildTags');
		// Should have a default value
		assert.ok(buildTags !== undefined);
	});
});
