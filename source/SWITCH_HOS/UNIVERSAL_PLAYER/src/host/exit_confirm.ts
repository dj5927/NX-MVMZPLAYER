import { Button } from '@nx.js/constants';
import type { LogFn } from '../types';

const HOLD_MS = 300;

function buttonDown(index: number) {
  const pad = navigator.getGamepads()[0];
  return !!pad?.buttons[index]?.pressed;
}

export function installGameExitConfirmation(log: LogFn, onConfirmExit: () => void) {
  const g: any = globalThis as any;
  const PIXI = g.PIXI ?? g.window?.PIXI;
  if (!PIXI?.Container || !PIXI?.Graphics || !PIXI?.Text) {
    log('[exit-confirm] PIXI overlay unavailable; exit confirmation not installed');
    return;
  }

  let active = false;
  let exitYes = false;
  let exitQueued = false;
  let suppressUntilRelease = false;
  let comboStartedAt: number | null = null;
  let comboLatched = false;
  let modal: any = null;
  let modalScene: any = null;

  let prevUp = false;
  let prevDown = false;
  let prevLeft = false;
  let prevRight = false;
  let prevConfirm = false;
  let prevCancel = false;

  const clearEngineInput = () => {
    try { g.Input?.clear?.(); } catch {}
    try { g.TouchInput?.clear?.(); } catch {}
  };

  const destroyModal = () => {
    if (!modal) return;
    try { modalScene?.removeChild?.(modal); } catch {}
    try { modal.destroy?.({ children: true }); } catch {
      try { modal.destroy?.(); } catch {}
    }
    modal = null;
    modalScene = null;
  };

  const addText = (container: any, text: string, size: number, color: number, x: number, y: number) => {
    const node = new PIXI.Text(text, {
      fontFamily: 'MVMZ_KoreanFallback',
      fontSize: size,
      fill: color,
      align: 'center'
    });
    try { node.anchor?.set?.(0.5, 0.5); } catch {}
    node.x = x;
    node.y = y;
    container.addChild(node);
    return node;
  };

  const renderModal = () => {
    const scene = g.SceneManager?._scene;
    if (!scene?.addChild) return false;
    destroyModal();

    const width = Math.max(320, Number(g.Graphics?.boxWidth || g.Graphics?.width || 816));
    const height = Math.max(240, Number(g.Graphics?.boxHeight || g.Graphics?.height || 624));
    const boxWidth = Math.min(560, width - 48);
    const boxHeight = Math.min(270, height - 48);
    const boxX = (width - boxWidth) * 0.5;
    const boxY = (height - boxHeight) * 0.5;
    const buttonWidth = Math.min(170, (boxWidth - 90) * 0.5);
    const buttonHeight = 60;
    const buttonGap = 34;
    const yesX = width * 0.5 - buttonGap * 0.5 - buttonWidth;
    const noX = width * 0.5 + buttonGap * 0.5;
    const buttonY = boxY + 126;

    const container = new PIXI.Container();
    const graphics = new PIXI.Graphics();
    graphics.beginFill(0x000000, 0.68);
    graphics.drawRect(0, 0, width, height);
    graphics.endFill();
    graphics.lineStyle(3, 0xd9e6ff, 1);
    graphics.beginFill(0x17202b, 1);
    graphics.drawRect(boxX, boxY, boxWidth, boxHeight);
    graphics.endFill();

    const drawButton = (x: number, selected: boolean) => {
      graphics.lineStyle(selected ? 3 : 1, selected ? 0xffffff : 0x526174, 1);
      graphics.beginFill(selected ? 0xd9e6ff : 0x283545, 1);
      graphics.drawRect(x, buttonY, buttonWidth, buttonHeight);
      graphics.endFill();
    };
    drawButton(yesX, exitYes);
    drawButton(noX, !exitYes);
    container.addChild(graphics);

    addText(container, '게임을 종료하시겠습니까?', 28, 0xffffff, width * 0.5, boxY + 66);
    addText(container, '예', 24, exitYes ? 0x10151d : 0xffffff, yesX + buttonWidth * 0.5, buttonY + buttonHeight * 0.5);
    addText(container, '아니오', 24, !exitYes ? 0x10151d : 0xffffff, noX + buttonWidth * 0.5, buttonY + buttonHeight * 0.5);
    addText(container, '←/→ 선택    A 결정    B 취소', 16, 0x9da8b6, width * 0.5, boxY + boxHeight - 30);

    try { container.z = 999999; } catch {}
    scene.addChild(container);
    modal = container;
    modalScene = scene;
    return true;
  };

  const openModal = () => {
    active = true;
    exitYes = false;
    g.__mvmzExitConfirmActive = true;
    clearEngineInput();
    renderModal();
    log('[exit-confirm] opened');
  };

  const closeModal = (reason: string) => {
    active = false;
    g.__mvmzExitConfirmActive = false;
    suppressUntilRelease = true;
    destroyModal();
    clearEngineInput();
    log(`[exit-confirm] closed | ${reason}`);
  };

  const input = g.Input;
  if (input?._updateGamepadState && !input._updateGamepadState.__mvmzExitConfirmGuard) {
    const original = input._updateGamepadState;
    const guarded = function(this: any, gamepad: any) {
      if (g.__mvmzExitConfirmActive || suppressUntilRelease) {
        try { this.clear?.(); } catch {}
        return;
      }
      return original.call(this, gamepad);
    };
    guarded.__mvmzExitConfirmGuard = true;
    input._updateGamepadState = guarded;
    log('[exit-confirm] RPG Maker gamepad guard installed');
  }

  setInterval(() => {
    const now = performance.now();
    const minus = buttonDown(Button.Minus);
    const plus = buttonDown(Button.Plus);
    const combo = minus && plus;
    const up = buttonDown(Button.Up);
    const down = buttonDown(Button.Down);
    const left = buttonDown(Button.Left);
    const right = buttonDown(Button.Right);
    const confirm = buttonDown(Button.A);
    const cancel = buttonDown(Button.B);

    if (suppressUntilRelease && !minus && !plus && !up && !down && !left && !right && !confirm && !cancel) {
      suppressUntilRelease = false;
      clearEngineInput();
      log('[exit-confirm] input guard released');
    }

    if (!active && !exitQueued) {
      if (combo) {
        if (comboStartedAt === null) comboStartedAt = now;
        if (!comboLatched && now - comboStartedAt >= HOLD_MS) {
          comboLatched = true;
          openModal();
          log(`[exit-confirm] Start+Select accepted | hold=${Math.round(now - comboStartedAt)}ms`);
        }
      } else {
        comboStartedAt = null;
        if (!minus && !plus) comboLatched = false;
      }
    }

    if (active) {
      if (g.SceneManager?._scene && g.SceneManager._scene !== modalScene) renderModal();
      if (left && !prevLeft) { exitYes = true; renderModal(); }
      if (right && !prevRight) { exitYes = false; renderModal(); }
      if ((up && !prevUp) || (down && !prevDown)) { exitYes = !exitYes; renderModal(); }

      if (cancel && !prevCancel) {
        closeModal('B cancel');
      } else if (confirm && !prevConfirm) {
        if (!exitYes) {
          closeModal('No');
        } else if (!exitQueued) {
          exitQueued = true;
          closeModal('Yes');
          log('[exit-confirm] confirmed -> launcher');
          setTimeout(() => {
            try { onConfirmExit(); }
            catch (error) {
              exitQueued = false;
              log(`[exit-confirm] launch callback FAILED | ${String(error)}`);
            }
          }, 80);
        }
      }
    }

    prevUp = up;
    prevDown = down;
    prevLeft = left;
    prevRight = right;
    prevConfirm = confirm;
    prevCancel = cancel;
  }, 50);

  log('[exit-confirm] installed | Start(+)+Select(-) hold=300ms | default=No');
}
