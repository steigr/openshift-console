import { mixHex } from '../colorSchemes';

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({ consoleFetchJSON: jest.fn() }));

describe('mixHex', () => {
  it('blends top over base by the given amount', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixHex('#073642', '#839496', 0)).toBe('#073642');
    expect(mixHex('#073642', '#839496', 1)).toBe('#839496');
  });

  it('accepts short and alpha hex forms', () => {
    expect(mixHex('#000', '#fff', 0.5)).toBe('#808080');
    expect(mixHex('#000000ff', '#ffffff80', 1)).toBe('#ffffff');
  });

  it('gives up on anything that is not hex', () => {
    expect(mixHex('rgb(0, 0, 0)', '#ffffff', 0.5)).toBeUndefined();
    expect(mixHex('#000000', 'white', 0.5)).toBeUndefined();
  });
});
