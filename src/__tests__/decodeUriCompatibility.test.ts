import { getPathFromState, getStateFromPath } from '@react-navigation/core';

describe('URI decoder compatibility', () => {
  it('keeps query-string decoding callable through CommonJS', () => {
    const queryString = require('query-string') as {
      parse(value: string): Record<string, string | null>;
    };

    expect(queryString.parse('screen=Review&value=%C3%A9')).toEqual({
      screen: 'Review',
      value: 'é',
    });
    expect(queryString.parse('value=%E0%A4%A').value).toBe('%E0%A4%A');
  });

  it('round-trips encoded route parameters through React Navigation', () => {
    const options = {
      screens: {
        Review: 'review/:pendingScanId',
      },
    };
    const state = {
      routes: [
        {
          name: 'Review',
          params: { pendingScanId: 'lot é%' },
        },
      ],
    };

    const path = getPathFromState(state, options);
    const parsed = getStateFromPath(path, options);

    expect(parsed?.routes[0]).toMatchObject({
      name: 'Review',
      params: { pendingScanId: 'lot é%' },
    });
  });
});
