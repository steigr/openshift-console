const k8sCreate = jest.fn();

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
  k8sCreate: (...args: unknown[]) => k8sCreate(...args),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getCurrentUsername, sanitizeUsername } = require('../currentUser');

describe('sanitizeUsername', () => {
  it('lowercases and passes through an already-clean username unchanged', () => {
    expect(sanitizeUsername('alice')).toBe('alice');
  });

  it('keeps only the local part of an email-style username', () => {
    expect(sanitizeUsername('Alice.Smith@example.com')).toBe('alice-smith');
  });

  it('replaces runs of non-POSIX characters with a single hyphen', () => {
    expect(sanitizeUsername('First Last (Admin)')).toBe('first-last-admin');
  });

  it('trims leading/trailing hyphens left over after replacement', () => {
    expect(sanitizeUsername('---alice---')).toBe('alice');
  });

  it('caps length at 32 characters', () => {
    const long = 'a'.repeat(50);
    expect(sanitizeUsername(long)).toHaveLength(32);
  });

  it('returns empty when nothing survives sanitization', () => {
    expect(sanitizeUsername('###')).toBe('');
    expect(sanitizeUsername('')).toBe('');
  });

  it('returns empty when the result would start with a digit', () => {
    // POSIX usernames can't start with a digit - identity_valid_username()
    // on the shim side would reject this anyway, but sanitizing to
    // something it's guaranteed to reject isn't useful.
    expect(sanitizeUsername('123alice')).toBe('');
  });
});

describe('getCurrentUsername', () => {
  beforeEach(() => {
    k8sCreate.mockReset();
  });

  it('returns the username from a successful SelfSubjectReview', async () => {
    k8sCreate.mockResolvedValue({ status: { userInfo: { username: 'alice' } } });
    await expect(getCurrentUsername()).resolves.toBe('alice');
    expect(k8sCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({ kind: 'SelfSubjectReview' }),
      }),
    );
  });

  it('returns null when the response has no username', async () => {
    k8sCreate.mockResolvedValue({ status: {} });
    await expect(getCurrentUsername()).resolves.toBeNull();
  });

  it('returns null (not a throw) when the k8sCreate call fails', async () => {
    k8sCreate.mockRejectedValue(new Error('no SelfSubjectReview on this cluster'));
    await expect(getCurrentUsername()).resolves.toBeNull();
  });
});
