/**
 * Default configuration values for the Ginkgo Test Adapter extension.
 */
export const constants = {
    /**
     * Configuration section identifier for VS Code settings
     */
    CONFIGURATION_SECTION: 'ginkgoTestAdapter',

    /**
     * Default path to the ginkgo executable.
     * Can be overridden in VS Code settings.
     */
    DEFAULT_GINKGO_PATH: 'ginkgo',

    /**
     * Default environment variables for running/debugging tests.
     * Can be overridden in VS Code settings.
     */
    DEFAULT_ENVIRONMENT_VARIABLES: {} as Record<string, string>,

    /**
     * Default build tags for running/debugging tests.
     * Can be overridden in VS Code settings.
     */
    DEFAULT_BUILD_TAGS: [] as string[],
};
