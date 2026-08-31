import { describe, expect, it } from 'vitest';
import { CommandHistory } from '../src/undo/history.ts';
import type { Command } from '../src/undo/history.ts';

/** A command that appends to a log so ordering is observable. */
function cmd(log: string[], name: string): Command {
  return {
    execute: () => log.push(`+${name}`),
    undo:    () => log.push(`-${name}`),
  };
}

describe('CommandHistory', () => {
  it('execute runs the command and enables undo', () => {
    const h = new CommandHistory();
    const log: string[] = [];
    h.execute(cmd(log, 'a'));
    expect(log).toEqual(['+a']);
    expect(h.canUndo).toBe(true);
    expect(h.canRedo).toBe(false);
  });

  it('commit pushes without re-executing', () => {
    const h = new CommandHistory();
    const log: string[] = [];
    h.commit(cmd(log, 'a'));
    expect(log).toEqual([]);
    expect(h.canUndo).toBe(true);
  });

  it('undo/redo walk the stacks in order', () => {
    const h = new CommandHistory();
    const log: string[] = [];
    h.commit(cmd(log, 'a'));
    h.commit(cmd(log, 'b'));
    h.undo();
    h.undo();
    expect(log).toEqual(['-b', '-a']);
    h.redo();
    expect(log).toEqual(['-b', '-a', '+a']);
    expect(h.canRedo).toBe(true);
    h.redo();
    expect(h.canRedo).toBe(false);
  });

  it('a new commit clears the redo stack', () => {
    const h = new CommandHistory();
    const log: string[] = [];
    h.commit(cmd(log, 'a'));
    h.undo();
    expect(h.canRedo).toBe(true);
    h.commit(cmd(log, 'b'));
    expect(h.canRedo).toBe(false);
  });

  it('undo/redo on empty stacks are no-ops', () => {
    const h = new CommandHistory();
    expect(() => { h.undo(); h.redo(); }).not.toThrow();
  });

  it('clear empties both stacks and depth tracks applied edits', () => {
    const h = new CommandHistory();
    const log: string[] = [];
    h.commit(cmd(log, 'a'));
    h.commit(cmd(log, 'b'));
    expect(h.depth).toBe(2);
    h.undo();
    expect(h.depth).toBe(1);
    h.clear();
    expect(h.depth).toBe(0);
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
  });

  it('notifies onChange for every mutation', () => {
    const h = new CommandHistory();
    let notified = 0;
    h.onChange = () => notified++;
    h.commit(cmd([], 'a')); // 1
    h.undo();               // 2
    h.redo();               // 3
    h.clear();              // 4
    expect(notified).toBe(4);
  });
});
