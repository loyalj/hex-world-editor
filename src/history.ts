export interface Command {
  execute(): void;
  undo(): void;
}

export class CommandHistory {
  private readonly undoStack: Command[] = [];
  private readonly redoStack: Command[] = [];
  onChange?: () => void;

  private notify(): void { this.onChange?.(); }

  execute(cmd: Command): void {
    cmd.execute();
    this.undoStack.push(cmd);
    this.redoStack.length = 0;
    this.notify();
  }

  undo(): void {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    cmd.undo();
    this.redoStack.push(cmd);
    this.notify();
  }

  redo(): void {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    cmd.execute();
    this.undoStack.push(cmd);
    this.notify();
  }

  /** Push a command that has already been applied — skips execute(), clears redo. */
  commit(cmd: Command): void {
    this.undoStack.push(cmd);
    this.redoStack.length = 0;
    this.notify();
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.notify();
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
}
