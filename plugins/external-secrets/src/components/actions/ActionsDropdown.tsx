import * as React from 'react';
import { Action, useAccessReview } from '@openshift-console/dynamic-plugin-sdk';
import {
  Dropdown,
  DropdownItem,
  DropdownList,
  MenuToggle,
  MenuToggleElement,
} from '@patternfly/react-core';
import { EllipsisVIcon } from '@patternfly/react-icons';

const ActionItem: React.FC<{ action: Action; onSelect: () => void }> = ({ action, onSelect }) => {
  const [allowed] = useAccessReview(action.accessReview || {});
  return (
    <DropdownItem
      key={action.id}
      isDisabled={!allowed}
      onClick={() => {
        if (typeof action.cta === 'function') {
          action.cta();
        }
        onSelect();
      }}
    >
      {action.label}
    </DropdownItem>
  );
};

type ActionsDropdownProps = {
  actions: Action[];
  isKebab?: boolean;
};

const ActionsDropdown: React.FC<ActionsDropdownProps> = ({ actions, isKebab }) => {
  const [isOpen, setIsOpen] = React.useState(false);
  const onSelect = () => setIsOpen(false);

  return (
    <Dropdown
      isOpen={isOpen}
      onOpenChange={setIsOpen}
      popperProps={{ position: 'right' }}
      toggle={(toggleRef: React.Ref<MenuToggleElement>) =>
        isKebab ? (
          <MenuToggle
            ref={toggleRef}
            aria-label="Actions"
            variant="plain"
            onClick={() => setIsOpen((v) => !v)}
            isExpanded={isOpen}
          >
            <EllipsisVIcon />
          </MenuToggle>
        ) : (
          <MenuToggle
            ref={toggleRef}
            onClick={() => setIsOpen((v) => !v)}
            isExpanded={isOpen}
          >
            Actions
          </MenuToggle>
        )
      }
    >
      <DropdownList>
        {actions.map((action) => (
          <ActionItem key={action.id} action={action} onSelect={onSelect} />
        ))}
      </DropdownList>
    </Dropdown>
  );
};

export default ActionsDropdown;
