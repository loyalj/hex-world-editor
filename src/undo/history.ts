export interface Command {
  execute(): void;
  undo(): void;
  /**
   * True for commands over state that isn't part of the saved document
   * (selection gestures). They ride the same stack — one Ctrl+Z stream —
   * but are excluded from {@link CommandHistory.documentDepth}, so they
   * never count as unsaved changes.
   */
  readonly transient?: boolean;
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

  /** Number of applied edits. Compare against a saved value to detect unsaved changes. */
  get depth(): number { return this.undoStack.length; }

  /** Applied edits that touch the saved document — transient commands don't count. */
  get documentDepth(): number {
    let n = 0;
    for (const cmd of this.undoStack) if (!cmd.transient) n++;
    return n;
  }
}
