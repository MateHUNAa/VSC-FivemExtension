import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { docBlockAbove, maskComments } from '../lsModules/luaLexer';
import { emitMetaFile } from '../lsModules/metaEmitter';
import {
  findReturnedTable,
  moduleFileCandidates,
  parseModuleFile,
  parseRegistrations,
  surfaceSteps,
} from '../lsModules/moduleParser';

describe('maskComments', () => {
  it('blanks line and block comments but keeps strings and line count', () => {
    const src = "local a = '--not a comment' -- gone\n--[[ block\nstill ]] local b = 1\n--[==[ x ]==]";
    const masked = maskComments(src);
    assert.equal(masked.split('\n').length, src.split('\n').length);
    assert.match(masked, /'--not a comment'/);
    assert.doesNotMatch(masked, /gone|block|still|x/);
    assert.match(masked, /local b = 1/);
  });
});

describe('parseRegistrations', () => {
  it('reads name, literal or implicit resource, and optional path', () => {
    const regs = parseRegistrations(
      [
        "LS:RegisterModule('Banking', cache.resource, 'modules/banking')",
        "LS:RegisterModule('UI', 'ls_ui', 'module')",
        '    LS:RegisterModule("Fuel", GetCurrentResourceName())',
      ].join('\n'),
    );
    assert.deepEqual(regs, [
      { moduleName: 'Banking', resourceName: undefined, path: 'modules/banking', line: 0 },
      { moduleName: 'UI', resourceName: 'ls_ui', path: 'module', line: 1 },
      { moduleName: 'Fuel', resourceName: undefined, path: '', line: 2 },
    ]);
  });

  it('ignores calls inside comments and the method definition itself', () => {
    const regs = parseRegistrations(
      "-- Registered via `LS:RegisterModule('UI', 'ls_ui', 'module')`\nfunction LS:RegisterModule(moduleName, resourceName, path) end",
    );
    assert.deepEqual(regs, []);
  });
});

describe('findReturnedTable', () => {
  it('uses the last column-0 return', () => {
    assert.equal(findReturnedTable('local X = {}\nfunction X:A()\n  return 1\nend\nreturn X\n'), 'X');
    assert.equal(findReturnedTable('local X = {}\n-- return Y\n'), undefined);
  });
});

describe('parseModuleFile', () => {
  it('collects methods, functions and fields with their doc blocks', () => {
    const src = [
      'local Banking = {}',
      '',
      '---@class Unrelated',
      '---@param id number',
      '---@return BankAccount?',
      'function Banking:GetAccount(id)',
      'end',
      'function Banking.Static(a, b) end',
      'Banking.Handler = function(self, x) end',
      'Banking.Version = 2',
      'return Banking',
    ].join('\n');
    const { members } = parseModuleFile(src, 'Banking');
    assert.deepEqual(
      members.map((m) => [m.name, m.kind, m.separator, m.params.join(',')]),
      [
        ['GetAccount', 'function', ':', 'id'],
        ['Static', 'function', '.', 'a,b'],
        ['Handler', 'function', '.', 'self,x'],
        ['Version', 'field', '.', ''],
      ],
    );
    assert.deepEqual(members[0].doc, ['---@param id number', '---@return BankAccount?']);
  });

  it('detects export-forwarding and alias loops', () => {
    const src = [
      'local UI = {}',
      "local exported <const> = {",
      "    -- Notification",
      "    'Notification',",
      "    'Progressbar', 'ShowTextUI',",
      '}',
      'local aliases <const> = {',
      "    Progress = 'Progressbar',",
      "    TextUI = 'ShowTextUI',",
      '}',
      'for _, name in ipairs(exported) do',
      '    UI[name] = function(_, ...) return exports.ls_ui[name](nil, ...) end',
      'end',
      'for alias, name in pairs(aliases) do',
      '    UI[alias] = UI[name]',
      'end',
      'return UI',
    ].join('\n');
    const surface = parseModuleFile(src, 'UI');
    assert.deepEqual(surface.forwards.map((f) => [f.resourceName, f.separator, f.exportNames]), [
      ['ls_ui', ':', ['Notification', 'Progressbar', 'ShowTextUI']],
    ]);
    assert.deepEqual(surface.aliases.map((a) => [a.alias, a.target]), [
      ['Progress', 'Progressbar'],
      ['TextUI', 'ShowTextUI'],
    ]);
  });
});

describe('surfaceSteps', () => {
  it('orders members after a forwarding loop so they override it, like the runtime', () => {
    const src = [
      'local Inventory = {}',
      'function Inventory:Early() end',
      "local exported <const> = { 'Early', 'GetItem', 'AddItem' }",
      'for _, name in ipairs(exported) do',
      '    Inventory[name] = function(_, ...) return exports.ls_inventory[name](nil, ...) end',
      'end',
      '---@return LSInventoryItem?',
      'function Inventory:GetItem(id) end',
      'return Inventory',
    ].join('\n');
    const steps = surfaceSteps(parseModuleFile(src, 'Inventory'));
    assert.deepEqual(
      steps.map((s) => (s.kind === 'member' ? `member:${s.member.name}` : s.kind)),
      ['member:Early', 'forward', 'member:GetItem'],
    );
  });
});

describe('moduleFileCandidates', () => {
  it('mirrors ls_core loadModule order', () => {
    assert.deepEqual(moduleFileCandidates('modules/banking', 'server').context.slice(0, 3), [
      'modules/banking/server.lua',
      'modules/banking/server/init.lua',
      'modules/banking/server/main.lua',
    ]);
    assert.deepEqual(moduleFileCandidates('', 'client').context, [
      'client.lua',
      'client/init.lua',
      'client/main.lua',
      'client/client.lua',
      'client/main.lua',
    ]);
  });
});

describe('docBlockAbove', () => {
  it('stops at the first non --- line', () => {
    assert.deepEqual(docBlockAbove(['---a', '', '---b', '---c', 'x'], 4), ['---b', '---c']);
  });
});

describe('emitMetaFile', () => {
  it('merges identical client/server members and keeps differing ones apart', () => {
    const out = emitMetaFile([
      {
        name: 'UI',
        resourceName: 'ls_ui',
        dir: 'module',
        unresolvedSides: [],
        sides: {
          client: [
            { name: 'Notification', kind: 'function', separator: ':', params: ['data'], doc: [] },
            { name: 'HideTextUI', kind: 'function', separator: ':', params: [], doc: [] },
          ],
          server: [{ name: 'Notification', kind: 'function', separator: ':', params: ['target', 'data'], doc: [] }],
        },
      },
      {
        name: 'Banking',
        resourceName: 'ls_banking',
        dir: 'modules/banking',
        unresolvedSides: [],
        sides: {
          server: [
            {
              name: 'GetAccount',
              kind: 'function',
              separator: ':',
              params: ['id'],
              doc: ['---@param id number'],
              source: { fsPath: 'E:\\res\\[core]\\ls_banking\\modules\\banking\\server.lua', line: 8, display: 'ls_banking/modules/banking/server.lua' },
            },
          ],
        },
      },
    ]);

    assert.ok(out.startsWith('---@meta\n'));
    assert.ok(out.indexOf('LS.Banking = Banking') < out.indexOf('LS.UI = UI'), 'modules are sorted');
    assert.match(out, /---@class LSModule\.UI\nlocal UI = \{\}/);
    assert.match(out, /---`client`\nfunction UI:Notification\(data\) end/);
    assert.match(out, /---`server`\nfunction UI:Notification\(target, data\) end/);
    assert.match(out, /---`client`\nfunction UI:HideTextUI\(\) end/);
    assert.match(
      out,
      /---`server` - \[ls_banking\/modules\/banking\/server\.lua:9\]\(file:\/\/\/.*%5Bcore%5D.*server\.lua#L9\)\n---\n---@param id number\nfunction Banking:GetAccount\(id\) end/,
    );
    assert.doesNotMatch(out, /\u2014/, 'no em dashes');
  });
});
