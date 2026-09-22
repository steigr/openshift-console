import * as React from 'react';
import type { FC } from 'react';
import { useEffect, useRef } from 'react';
import { Divider, Menu, MenuContent, MenuItem, MenuList } from '@patternfly/react-core';

export type MenuAction = {
  id: string;
  label: string;
  onSelect: () => void;
  isDisabled?: boolean;
  isDanger?: boolean;
  separatorBefore?: boolean;
  description?: string;
};

type ContextMenuProps = {
  x: number;
  y: number;
  actions: MenuAction[];
  onClose: () => void;
};

/**
 * A menu pinned to the pointer, which the browser's own context menu has been
 * suppressed in favour of.
 *
 * It is positioned with `position: fixed` against the viewport rather than
 * with PatternFly's popper: the anchor is a point, not an element, and the
 * tree it opens over scrolls underneath it.
 */
export const ContextMenu: FC<ContextMenuProps> = ({ x, y, actions, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    // Capture, so a click that lands on a tree row closes the menu before the
    // row's own handler moves the selection out from under it.
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onClose, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  // Keep the menu on screen when the click was near the right or bottom edge.
  const width = 240;
  const height = Math.min(actions.length * 40 + 16, 420);
  const left = Math.min(x, Math.max(0, window.innerWidth - width - 8));
  const top = Math.min(y, Math.max(0, window.innerHeight - height - 8));

  return (
    <div
      ref={ref}
      className="filesystem-context-menu"
      style={{ position: 'fixed', left, top, zIndex: 9999, width }}
      data-test="filesystem-context-menu"
    >
      <Menu
        isPlain
        onSelect={(_event, itemId) => {
          onClose();
          actions.find((action) => action.id === itemId)?.onSelect();
        }}
      >
        <MenuContent>
          <MenuList>
            {actions.map((action) => (
              <React.Fragment key={action.id}>
                {action.separatorBefore && <Divider component="li" />}
                <MenuItem
                  itemId={action.id}
                  isDisabled={action.isDisabled}
                  isDanger={action.isDanger}
                  description={action.description}
                  data-test={`filesystem-action-${action.id}`}
                >
                  {action.label}
                </MenuItem>
              </React.Fragment>
            ))}
          </MenuList>
        </MenuContent>
      </Menu>
    </div>
  );
};
