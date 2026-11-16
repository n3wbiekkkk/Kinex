import { useLayoutEffect, type RefObject } from 'react';

export const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

export function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.tabIndex >= 0 && element.getClientRects().length > 0 && !element.closest('[inert]')
  );
}

export function useModalFocus(
  ref: RefObject<HTMLDivElement | null>,
  key: string,
  active: boolean,
  onClose: () => void
): void {
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !active) return;
    const initial = root.querySelector<HTMLElement>('[data-initial-focus]') ?? focusableElements(root)[0] ?? root;
    initial.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (event.key === 'Tab') {
        const items = focusableElements(root);
        const index = items.indexOf(document.activeElement as HTMLElement);
        if (!items.length) {
          event.preventDefault();
          root.focus();
        } else if (event.shiftKey && index <= 0) {
          event.preventDefault();
          items[items.length - 1].focus();
        } else if (!event.shiftKey && (index === -1 || index === items.length - 1)) {
          event.preventDefault();
          items[0].focus();
        }
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (document.hasFocus() && event.target instanceof Node && !root.contains(event.target)) {
        (focusableElements(root)[0] ?? root).focus({ preventScroll: true });
      }
    };
    root.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      root.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [ref, key, active, onClose]);
}
