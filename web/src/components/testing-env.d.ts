/**
 * Augments Vitest's `expect` with the @testing-library/jest-dom matchers
 * (toBeInTheDocument, toHaveTextContent, toHaveAttribute, etc.) for the jsdom
 * component-test project.
 *
 * The runtime registration happens via the jsdom project's `setupFiles` entry
 * ("@testing-library/jest-dom/vitest"); this file ensures TypeScript picks up
 * the type augmentations.
 */
/// <reference types="@testing-library/jest-dom" />
