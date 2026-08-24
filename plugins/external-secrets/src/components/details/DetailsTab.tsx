import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { K8sResourceCommon, ResourceLink, Timestamp } from '@openshift-console/dynamic-plugin-sdk';
import {
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  Label,
  LabelGroup,
  PageSection,
  Title,
} from '@patternfly/react-core';

type DetailsTabProps<T extends K8sResourceCommon> = {
  obj: T;
  renderExtra?: (obj: T) => React.ReactNode;
};

function DetailsTab<T extends K8sResourceCommon>({ obj, renderExtra }: DetailsTabProps<T>) {
  const { t } = useTranslation('plugin__external-secrets');

  if (!obj) {
    return null;
  }

  const owner = obj.metadata?.ownerReferences?.find((o) => o.controller) || obj.metadata?.ownerReferences?.[0];
  const [ownerGroup, ownerVersion] = (owner?.apiVersion || '').includes('/')
    ? owner.apiVersion.split('/')
    : [undefined, owner?.apiVersion];
  const labels = obj.metadata?.labels || {};
  const annotations = obj.metadata?.annotations || {};

  return (
    <PageSection>
      <Title headingLevel="h2" className="pf-v6-u-mb-md">
        {t('{{kind}} details', { kind: obj.kind })}
      </Title>
      <DescriptionList>
        <DescriptionListGroup>
          <DescriptionListTerm>{t('Name')}</DescriptionListTerm>
          <DescriptionListDescription>{obj.metadata?.name}</DescriptionListDescription>
        </DescriptionListGroup>
        {obj.metadata?.namespace && (
          <DescriptionListGroup>
            <DescriptionListTerm>{t('Namespace')}</DescriptionListTerm>
            <DescriptionListDescription>
              <ResourceLink kind="Namespace" name={obj.metadata.namespace} />
            </DescriptionListDescription>
          </DescriptionListGroup>
        )}
        <DescriptionListGroup>
          <DescriptionListTerm>{t('Labels')}</DescriptionListTerm>
          <DescriptionListDescription>
            {Object.keys(labels).length === 0 ? (
              t('No labels')
            ) : (
              <LabelGroup>
                {Object.entries(labels).map(([key, value]) => (
                  <Label key={key}>
                    {key}={value}
                  </Label>
                ))}
              </LabelGroup>
            )}
          </DescriptionListDescription>
        </DescriptionListGroup>
        <DescriptionListGroup>
          <DescriptionListTerm>{t('Annotations')}</DescriptionListTerm>
          <DescriptionListDescription>
            {t('{{count}} annotations', { count: Object.keys(annotations).length })}
          </DescriptionListDescription>
        </DescriptionListGroup>
        <DescriptionListGroup>
          <DescriptionListTerm>{t('Created')}</DescriptionListTerm>
          <DescriptionListDescription>
            <Timestamp timestamp={obj.metadata?.creationTimestamp} />
          </DescriptionListDescription>
        </DescriptionListGroup>
        <DescriptionListGroup>
          <DescriptionListTerm>{t('Owner')}</DescriptionListTerm>
          <DescriptionListDescription>
            {owner ? (
              <ResourceLink
                groupVersionKind={{ group: ownerGroup, version: ownerVersion, kind: owner.kind }}
                name={owner.name}
                namespace={obj.metadata?.namespace}
              />
            ) : (
              t('No owner')
            )}
          </DescriptionListDescription>
        </DescriptionListGroup>
        {renderExtra?.(obj)}
      </DescriptionList>
    </PageSection>
  );
}

export default DetailsTab;
