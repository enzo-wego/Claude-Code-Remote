/**
 * T06: Tests for systemBlock prepending in CLI adapters.
 * Verifies buildPromptText utility extracted from claude-adapter.
 */

const { buildPromptText } = require('../../src/cli/claude-adapter');

describe('buildPromptText', () => {
    test('systemBlock is prepended with a separator', () => {
        const out = buildPromptText({
            prompt: 'User question',
            systemBlock: '## Graph\n\nSome context',
        });
        expect(out).toMatch(/## Graph[\s\S]+---[\s\S]+User question/);
    });

    test('absent systemBlock leaves prompt unchanged', () => {
        const out = buildPromptText({ prompt: 'User question' });
        expect(out).toBe('User question');
    });

    test('empty systemBlock leaves prompt unchanged', () => {
        const out = buildPromptText({ prompt: 'User question', systemBlock: '' });
        expect(out).toBe('User question');
    });
});
