import { k8sCreate } from '@openshift-console/dynamic-plugin-sdk';
import type { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

import { SelfSubjectReviewModel } from './models';

type SelfSubjectReview = K8sResourceCommon & {
  status?: { userInfo?: { username?: string } };
};

/**
 * The username of the person currently using the console, as the k8s API
 * server itself sees them - not anything console core tracks internally
 * (no public SDK hook exposes that), but a SelfSubjectReview
 * (authentication.k8s.io/v1, built into Kubernetes since 1.28) answers it
 * authoritatively: console's own k8s API proxy makes this call *as* the
 * logged-in user (via their OIDC token), so status.userInfo.username in the
 * response is exactly what the API server itself would attribute any other
 * request from this same session to.
 *
 * Returns null (not a throw) if the call fails for any reason - an older
 * k8s API server without SelfSubjectReview, a proxy/network hiccup, or an
 * unexpected response shape - since this is purely a UX nicety (a readable
 * account name in the Node Terminal session): the debug pod's own ephemeral
 * k8s-sess-<hex> account naming already works correctly without it.
 */
export const getCurrentUsername = async (): Promise<string | null> => {
  try {
    const review = await k8sCreate<SelfSubjectReview>({
      model: SelfSubjectReviewModel,
      data: { kind: 'SelfSubjectReview', apiVersion: 'authentication.k8s.io/v1' },
    });
    return review?.status?.userInfo?.username || null;
  } catch {
    return null;
  }
};

/**
 * Best-effort POSIX-username-safe transform of an arbitrary OIDC username
 * (which might be an email address, contain spaces/uppercase/unicode,
 * etc): lowercases, drops an email-style "@domain" suffix, keeps only
 * [a-z0-9_-], trims stray separators, and caps length.
 *
 * This is *not* the security boundary - the node-terminal shim's own
 * identity_valid_username() is (this runs in the browser, fully
 * attacker-controlled, and the shim must never trust it blindly since the
 * result gets written straight into the host's passwd/shadow/group files).
 * This is purely about maximizing the chance of ending up with something
 * readable, rather than falling back to the generic k8s-sess-<hex> scheme
 * for every realistic OIDC username shape.
 *
 * Returns '' if nothing usable survives sanitization (e.g. the input was
 * all-symbols, or empty) - callers should treat that the same as "no
 * username available" and omit the request entirely.
 */
export const sanitizeUsername = (raw: string): string => {
  const localPart = raw.toLowerCase().split('@')[0];
  const cleaned = localPart
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 32);
  return /^[a-z_]/.test(cleaned) ? cleaned : '';
};
