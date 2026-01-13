/**
 * Default configuration values for the Ginkgo Test Adapter extension.
 */
export const constants = {
    /**
     * Configuration section identifier for VS Code settings
     */
    configurationSection: 'ginkgoTestAdapter',

    /**
     * Default path to the ginkgo executable.
     * Can be overridden in VS Code settings.
     */
    defaultGinkgoPath: 'ginkgo',

    /**
     * Default environment variables for running/debugging tests.
     * Can be overridden in VS Code settings.
     */
    defaultEnvironmentVariables: {} as Record<string, string>,

    /**
     * Default build tags for running/debugging tests.
     * Can be overridden in VS Code settings.
     */
    defaultBuildTags: [] as string[],
};
