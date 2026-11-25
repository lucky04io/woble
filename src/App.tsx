import { useCallback, useEffect, useRef, useState } from 'react';
import { createGameEngine } from './game/GameEngine';
import type { GameEngineHandle, HandTargetingHudSnapshot } from './game/types';
import { GameHud } from './components/GameHud';

const INITIAL_HAND_TARGETING: HandTargetingHudSnapshot = {
  left: {
    active: false,
    locked: false,
    held: false,
    mode: 'idle',
    surfaceKind: null,
    outOfReach: false,
    blockId: null,
  },
  right: {
    active: false,
    locked: false,
    held: false,
    mode: 'idle',
    surfaceKind: null,
    outOfReach: false,
    blockId: null,
  },
  hoverInReach: false,
  hoverKind: null,
};

export default function App() {
  const canvasMountRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<GameEngineHandle | null>(null);

  const [isPointerLocked, setIsPointerLocked] = useState(false);
  const [isHudExpanded, setIsHudExpanded] = useState(true);
  const [webglError, setWebglError] = useState<string | null>(null);
  const [handTargeting, setHandTargeting] =
    useState<HandTargetingHudSnapshot>(INITIAL_HAND_TARGETING);

  useEffect(() => {
    const container = canvasMountRef.current;
    if (!container) return;

    const engine = createGameEngine(container, {
      onPointerLockChange: (locked) => setIsPointerLocked(locked),
      onWebGLError: (message) => setWebglError(message),
      onHandTargetingChange: (snapshot) => setHandTargeting(snapshot),
    });

    engineRef.current = engine;

    return () => {
      engine?.dispose();
      engineRef.current = null;
    };
  }, []);

  const handleToggleExpanded = useCallback(() => {
    setIsHudExpanded((prev) => !prev);
  }, []);

  const handleDropFromSky = useCallback(() => {
    engineRef.current?.dropCharacterFromSky();
  }, []);

  const handleNudge = useCallback(() => {
    engineRef.current?.nudgeCharacter();
  }, []);

  const handleResetBlocks = useCallback(() => {
    engineRef.current?.resetBlocks();
  }, []);

  const handleTogglePointerLock = useCallback(() => {
    engineRef.current?.togglePointerLock();
  }, []);

  return (
    <main className="relative h-full w-full overflow-hidden bg-[#d8ecf8]">
      {/* Isolated WebGL canvas container (never re-rendered on HUD state updates) */}
      <div
        ref={canvasMountRef}
        className={`fixed inset-0 h-full w-full ${
          handTargeting.hoverInReach ? 'cursor-crosshair' : 'cursor-default'
        }`}
        aria-label="Wobblepeak 3D game viewport"
      />

      {webglError ? (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-gradient-to-b from-[#a7d6f8] to-[#f4ece2] p-6">
          <div className="max-w-md rounded-xl border border-slate-900/12 bg-white/95 p-6 text-center shadow-lg">
            <h1
              className="text-2xl font-bold text-slate-900"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              Wobblepeak
            </h1>
            <p className="mt-2 text-sm text-slate-600">{webglError}</p>
            <p className="mt-1 text-xs text-slate-500">
              Please enable hardware acceleration or use a WebGL2-compatible browser to view the 3D scene.
            </p>
          </div>
        </div>
      ) : (
        <GameHud
          isPointerLocked={isPointerLocked}
          isExpanded={isHudExpanded}
          handTargeting={handTargeting}
          onToggleExpanded={handleToggleExpanded}
          onDropFromSky={handleDropFromSky}
          onNudge={handleNudge}
          onResetBlocks={handleResetBlocks}
          onTogglePointerLock={handleTogglePointerLock}
        />
      )}
    </main>
  );
}
