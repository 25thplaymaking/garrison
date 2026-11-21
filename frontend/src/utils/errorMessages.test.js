import { describe, expect, it } from 'vitest';

import { formatApiError } from './errorMessages';

describe('formatApiError', () => {
  it('formats FastAPI validation details as render-safe text', () => {
    const error = {
      response: {
        data: {
          detail: [
            { loc: ['body', 'timezone'], msg: 'String should have at most 100 characters' },
            { loc: ['body', 'availability'], msg: 'Field required' },
          ],
        },
      },
    };

    expect(formatApiError(error, 'Submission failed')).toBe(
      'String should have at most 100 characters; Field required',
    );
  });

  it('uses the fallback for responses without a useful detail', () => {
    expect(formatApiError({ response: { data: {} } }, 'Submission failed')).toBe(
      'Submission failed',
    );
  });
});
