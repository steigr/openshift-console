import { nodeJournalURL, parseUnits, podLogURL } from './log-urls';

describe('podLogURL', () => {
  const base = {
    namespace: 'shop',
    podName: 'checkout-0',
    container: 'app',
    follow: true,
    previous: false,
  };

  it('asks for a bounded tail', () => {
    const url = podLogURL({ ...base, tailLines: 10_000 });
    expect(url).toContain('/namespaces/shop/pods/checkout-0/log');
    expect(url).toContain('tailLines=10000');
    expect(url).toContain('follow=true');
  });

  it('omits tailLines entirely for the whole log', () => {
    // Not tailLines=0: that is a valid request for zero lines.
    expect(podLogURL({ ...base, tailLines: null })).not.toContain('tailLines');
  });

  it('escapes names rather than splicing them into the path', () => {
    const url = podLogURL({ ...base, namespace: 'a/b', tailLines: 1 });
    expect(url).toContain('/namespaces/a%2Fb/');
  });
});

describe('nodeJournalURL', () => {
  it('asks the plugin proxy for JSON', () => {
    const url = nodeJournalURL({
      node: 'node-1',
      units: [],
      tailLines: 10_000,
    });
    expect(url).toContain(
      '/api/proxy/plugin/logging-console-plugin/api/v1/nodes/node-1/journal',
    );
    expect(url).toContain('output=json');
    expect(url).toContain('tailLines=10000');
  });

  it('spells "the whole journal" as tailLines=0', () => {
    // The backend reads 0 as "no -n flag at all"; leaving the parameter out
    // would instead get its default tail.
    expect(nodeJournalURL({ node: 'n', units: [], tailLines: null })).toContain(
      'tailLines=0',
    );
  });

  it('repeats the unit parameter, as journalctl -u does', () => {
    const url = nodeJournalURL({
      node: 'n',
      units: ['kubelet.service', 'crio.service'],
      tailLines: 10,
    });
    expect(url).toContain('unit=kubelet.service');
    expect(url).toContain('unit=crio.service');
  });
});

describe('parseUnits', () => {
  it('splits on commas and whitespace', () => {
    expect(parseUnits('kubelet.service, crio.service  sshd')).toEqual([
      'kubelet.service',
      'crio.service',
      'sshd',
    ]);
  });

  it('drops anything the backend would reject', () => {
    // A leading dash would reach journalctl as a flag.
    expect(parseUnits('-u, --version, kubelet.service')).toEqual([
      'kubelet.service',
    ]);
  });

  it('is empty for an empty filter', () => {
    expect(parseUnits('   ')).toEqual([]);
  });
});
