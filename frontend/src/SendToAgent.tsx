import { sceneCoordsToViewportCoords, viewportCoordsToSceneCoords } from '@excalidraw/excalidraw';
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { useEffect, useRef, useState } from 'react';
import type { Handoff, HandoffResult, Point, Region } from '../../src/shared/protocol';
import { handoffFor, isMarkable, normalizeRect } from './region';

interface Props {
  api: ExcalidrawImperativeAPI;
  send(h: Handoff): Promise<HandoffResult>;
}

/** A right-click: where it was (scene and screen) and what was selected then. */
interface Menu {
  point: Point;
  ids: string[];
  /** Screen position of Excalidraw's menu, to sit beside it. */
  left: number;
  top: number;
}

const PANEL_WIDTH = 300;
const PANEL_GAP = 8;
const TOAST_MS = 4000;
const MESSAGES: Record<HandoffResult, string> = {
  agent: 'Sent to agent',
  note: 'No agent session is on this board; left it as a note',
};

const selectedIds = (s: AppState) => Object.entries(s.selectedElementIds).filter(([, on]) => on).map(([id]) => id);

/**
 * "Send to agent": a button beside Excalidraw's own right-click menu (which Excalidraw doesn't let us add
 * items to), and the marked region: Excalidraw forgets a drag box on release, so we keep it and draw it
 * until the next click, Escape, or until it's sent.
 */
export function SendToAgent({ api, send }: Props) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState('');
  const [region, setRegion] = useState<Region | null>(null);
  const [view, setView] = useState(() => api.getAppState());
  const regionRef = useRef(region);
  regionRef.current = region;
  /** The drag box of the left-button drag in progress, if any. */
  const dragRef = useRef<Region | null>(null);
  const draggingRef = useRef(false);
  const menuOpenRef = useRef(false);
  const writingRef = useRef(writing);
  writingRef.current = writing;
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const offChange = api.onChange((_elements, state) => {
      // The drag box while the left button drags; read on pointer-up. Excalidraw may still report the
      // last box after release, so only a drag in progress counts.
      if (draggingRef.current && state.selectionElement) dragRef.current = normalizeRect(state.selectionElement);
      if (regionRef.current) setView(state);
      const open = !!state.contextMenu;
      if (open && !menuOpenRef.current) {
        const cm = state.contextMenu!;
        const clientX = cm.left + state.offsetLeft;
        const clientY = cm.top + state.offsetTop;
        const { x, y } = viewportCoordsToSceneCoords({ clientX, clientY }, state);
        setMenu({ point: { x, y }, ids: selectedIds(state), left: clientX, top: clientY });
        setWriting(false);
        setText('');
      } else if (!open && menuOpenRef.current && !writingRef.current) {
        setMenu(null);
      }
      menuOpenRef.current = open;
    });
    const offUp = api.onPointerUp(() => {
      const drag = draggingRef.current ? dragRef.current : null;
      draggingRef.current = false;
      dragRef.current = null;
      const state = api.getAppState();
      if (drag && isMarkable(drag, state.zoom.value)) {
        setRegion(drag);
        setView(state);
      }
    });
    const offDown = api.onPointerDown((_tool, _state, event) => {
      // A left click starts over; a right-click (or ctrl-click on a Mac) keeps the region to send it.
      if (event.button !== 0 || event.ctrlKey) return;
      setRegion(null);
      dragRef.current = null;
      draggingRef.current = true;
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !writingRef.current) setRegion(null);
    };
    // Capture: Excalidraw handles Escape itself and stops it.
    window.addEventListener('keydown', onKey, true);
    return () => {
      offChange();
      offUp();
      offDown();
      window.removeEventListener('keydown', onKey, true);
    };
  }, [api]);

  useEffect(() => {
    if (writing) field.current?.focus();
  }, [writing]);

  const close = () => {
    setMenu(null);
    setWriting(false);
    setText('');
    if (api.getAppState().contextMenu) api.updateScene({ appState: { contextMenu: null } });
  };

  const go = (m: Menu, instruction: string) => {
    const h = handoffFor(m.point, m.ids, regionRef.current ?? undefined);
    const sent = h.region;
    close();
    // Cleared now, not on the answer: the human may already be marking the next region by then.
    if (sent) setRegion(null);
    send(instruction ? { ...h, text: instruction } : h).then(
      (result) => api.setToast({ message: MESSAGES[result], duration: TOAST_MS }),
      (err: unknown) => {
        // Not sent: give the region back, unless a new one was marked meanwhile.
        if (sent) setRegion((current) => current ?? sent);
        api.setToast({ message: `Not sent: ${err instanceof Error ? err.message : String(err)}`, closable: true });
      },
    );
  };

  // Act on pointer-down: Excalidraw closes its menu (and with it our button) on any pointer-down outside it.
  const act = (fn: () => void) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    fn();
  };

  const inRegion = !!(menu && region && handoffFor(menu.point, [], region).region);
  const left = menu ? Math.max(PANEL_GAP, Math.min(menu.left, window.innerWidth - PANEL_WIDTH - PANEL_GAP)) : 0;
  // Above Excalidraw's menu (which opens downward from the click); below the click when there is no room.
  const above = menu ? menu.top - 44 >= PANEL_GAP : true;
  const top = menu ? (above ? menu.top - 44 : menu.top + PANEL_GAP) : 0;

  let box: { left: number; top: number; width: number; height: number } | null = null;
  if (region) {
    const a = sceneCoordsToViewportCoords({ sceneX: region.x, sceneY: region.y }, view);
    const b = sceneCoordsToViewportCoords({ sceneX: region.x + region.width, sceneY: region.y + region.height }, view);
    box = { left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y };
  }

  return (
    <>
      {box && <div className="xl-region" data-testid="handoff-region" style={box} aria-hidden />}
      {menu && !writing && (
        <div className="xl-handoff" data-testid="handoff-menu" style={{ left, top }} onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
          <button type="button" className="xl-handoff-send" onPointerDown={act(() => go(menu, ''))}>
            {inRegion ? 'Send region to agent' : 'Send to agent'}
          </button>
          <button type="button" className="xl-handoff-more" onPointerDown={act(() => setWriting(true))}>
            Add instruction…
          </button>
        </div>
      )}
      {menu && writing && (
        <form
          className="xl-handoff xl-handoff--form"
          data-testid="handoff-form"
          style={{ left, top }}
          onPointerDown={(e) => e.stopPropagation()}
          onSubmit={(e) => {
            e.preventDefault();
            go(menu, text.trim());
          }}
        >
          <input
            ref={field}
            value={text}
            maxLength={4000}
            placeholder={inRegion ? 'What should the agent do with this region?' : 'What should the agent do here?'}
            aria-label="Instruction for the agent"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') close();
            }}
          />
          <button type="submit" className="xl-send">
            Send
          </button>
        </form>
      )}
    </>
  );
}
