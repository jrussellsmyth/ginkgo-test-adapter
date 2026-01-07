/**
 * Default configuration values for the Ginkgo Test Adapter extension.
 */

/**
 * Default path to the ginkgo executable.
 * Can be overridden in VS Code settings.
 */
export const DEFAULT_GINKGO_PATH = 'ginkgo';

/**
 * Default environment variables for running/debugging tests.
 * Can be overridden in VS Code settings.
 */
export const DEFAULT_ENVIRONMENT_VARIABLES: Record<string, string> = {};

/**
 * Default build tags for running/debugging tests.
 * Can be overridden in VS Code settings.
 */
export const DEFAULT_BUILD_TAGS: string[] = [];
