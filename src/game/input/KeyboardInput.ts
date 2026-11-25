export interface MovementInputState {
  /** -1 (backward/S) to +1 (forward/W) */
  forward: number;
  /** -1 (left/A) to +1 (right/D) */
  right: number;
  /** True while Shift is held */
  run: boolean;
  /** True if a fresh jump press is currently buffered */
  jumpBuffered: boolean;
  /** True while Space is currently held down */
  jumpHeld: boolean;
}

const JUMP_BUFFER_SECONDS = 0.15;

export class KeyboardInput {
  private readonly keys = new Set<string>();
  private jumpBufferTimer = 0;
  private readonly onUserInteract: () => void;

  constructor(onUserInteract: () => void) {
    this.onUserInteract = onUserInteract;
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable)
    ) {
      return;
    }

    const { code } = event;
    if (
      code === 'Space' ||
      code === 'ArrowUp' ||
      code === 'ArrowDown' ||
      code === 'ArrowLeft' ||
      code === 'ArrowRight'
    ) {
      event.preventDefault();
    }

    if (
      code === 'KeyW' ||
      code === 'KeyA' ||
      code === 'KeyS' ||
      code === 'KeyD' ||
      code === 'Space' ||
      code === 'ShiftLeft' ||
      code === 'ShiftRight'
    ) {
      this.onUserInteract();
    }

    if (code === 'Space' && !event.repeat && !this.keys.has('Space')) {
      this.jumpBufferTimer = JUMP_BUFFER_SECONDS;
    }

    this.keys.add(code);
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private readonly handleBlur = (): void => {
    this.keys.clear();
    this.jumpBufferTimer = 0;
  };

  private readonly handleVisibilityChange = (): void => {
    if (document.hidden) {
      this.keys.clear();
      this.jumpBufferTimer = 0;
    }
  };

  public tick(dt: number): void {
    if (this.jumpBufferTimer > 0) {
      this.jumpBufferTimer = Math.max(0, this.jumpBufferTimer - dt);
    }
  }

  public consumeJumpBuffer(): boolean {
    if (this.jumpBufferTimer > 0) {
      this.jumpBufferTimer = 0;
      return true;
    }
    return false;
  }

  public getState(out: MovementInputState): MovementInputState {
    const forward =
      (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0) -
      (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0);
    const right =
      (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0) -
      (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0);

    out.forward = forward;
    out.right = right;
    out.run = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    out.jumpBuffered = this.jumpBufferTimer > 0;
    out.jumpHeld = this.keys.has('Space');
    return out;
  }

  public dispose(): void {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.keys.clear();
  }
}
