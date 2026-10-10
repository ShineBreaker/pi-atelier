// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * TUI 配置面板 — /atelier-config 的图形化编辑界面
 *
 * 层级（全部靠 SettingItem.submenu 嵌套 SettingsList / Input 实现）：
 *   顶层：6 个标量 + defaultTier + tiers › + modelSchedules › + 保存
 *     tiers ›          → tier 详情（model / fallback / 删除）
 *     modelSchedules › → 时段详情（allow / deny / 删除）
 *
 * 所有编辑只落在 draft 深拷贝上，仅「保存并应用」才 saveConfig 写盘并重新
 * loadConfig 返回给调用方热替换 —— 面板里的中间态（tier 填了 model 还没填
 * fallback）不会污染磁盘配置，Esc 直接丢弃草稿。
 */

import {
  getSettingsListTheme,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  SettingsList,
  Text,
  type Component,
  type SettingItem,
} from "@earendil-works/pi-tui";
import { loadConfig, resolveConfigTarget, saveConfig } from "../core/config.ts";
import type { SubagentConfig } from "../core/types.ts";

/** 列表可见行数上限（超出走 SettingsList 自带滚动） */
const MAX_VISIBLE = 15;

/** 逗号分隔串 → 去空白、去空项的数组 */
function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 打开配置面板。保存后返回新 loadConfig() 结果（供调用方热替换 config 变量），
 * 放弃（Esc）返回 null。必须在 TUI 模式下调用（ctx.ui.custom 仅 TUI 可用）。
 */
export async function openConfigPanel(
  ctx: ExtensionCommandContext,
  config: SubagentConfig,
): Promise<SubagentConfig | null> {
  // SubagentConfig 全是 JSON 可表达的纯数据，JSON 往返即深拷贝
  const draft: SubagentConfig = JSON.parse(JSON.stringify(config));
  let dirty = false;
  const targetPath = resolveConfigTarget().path;

  return await ctx.ui.custom<SubagentConfig | null>(
    (_tui, theme, _keybindings, done) => {
      /** 给嵌套 list 套标题：submenu 会整屏接管渲染，没标题就看不出身处哪一层 */
      const wrap = (title: string, list: SettingsList): Component => {
        const box = new Container();
        box.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 1));
        box.addChild(list);
        return {
          render: (w) => box.render(w),
          invalidate: () => box.invalidate(),
          handleInput: (data) => list.handleInput(data),
        };
      };

      /** 单行文本输入子菜单：Enter → submit(value)，Esc → submit(undefined)（仅关闭） */
      const textEdit = (
        prompt: string,
        initial: string,
        submit: (value?: string) => void,
      ): Component => {
        const input = new Input();
        // 用 handleInput 而非 setValue 预填：setValue 不动光标（停在 0），
        // 追加编辑会插到最前面
        if (initial) input.handleInput(initial);
        input.onSubmit = (value) => submit(value);
        input.onEscape = () => submit(undefined);
        const box = new Container();
        box.addChild(
          new Text(
            theme.fg("dim", `${prompt} · Enter 确认 · Esc 取消`),
            1,
            1,
          ),
        );
        box.addChild(input);
        return {
          render: (w) => box.render(w),
          invalidate: () => box.invalidate(),
          handleInput: (data) => input.handleInput(data),
        };
      };

      /**
       * 目标已被删除时的占位页。
       *
       * 开了 enableSearch 后 SettingsList 的过滤视图可能仍持有被删掉的行
       * （filteredItems 是快照），点进来不能直接崩；submenu 又不允许在返回前
       * 同步 done（会被 activateItem 的赋值覆盖成僵尸子菜单），故用占位页等按键。
       */
      const goneNotice = (
        message: string,
        closeSelf: (value?: string) => void,
      ): Component => {
        const box = new Container();
        box.addChild(new Text(theme.fg("warning", message), 1, 1));
        box.addChild(new Text(theme.fg("dim", "按任意键返回"), 1, 0));
        return {
          render: (w) => box.render(w),
          invalidate: () => box.invalidate(),
          handleInput: () => closeSelf(),
        };
      };

      // ── tiers ──────────────────────────────────────────────────────────────

      // PR-12: routes 优先展示（harness/model 混合路由链），旧式退回 model
      const tierValue = (name: string): string => {
        const t = draft.tiers[name];
        if (t.routes && t.routes.length > 0) return t.routes.join(" → ");
        return t.model || "(未设置 model)";
      };

      const buildTierList = (
        closeList: (value?: string) => void,
      ): Component => {
        const rows: SettingItem[] = [];

        function tierRow(name: string): SettingItem {
          return {
            id: `tier:${name}`,
            label: name,
            currentValue: tierValue(name),
            submenu: (_cur, closeDetail) => buildTierDetail(name, closeDetail),
          };
        }

        function buildTierDetail(
          name: string,
          closeDetail: (value?: string) => void,
        ): Component {
          const tier = draft.tiers[name];
          if (!tier) return goneNotice(`tier "${name}" 已删除`, closeDetail);

          const fields: SettingItem[] = [
            {
              id: "model",
              label: "model",
              description: "首选模型名，如 zai/GLM-5.2",
              currentValue: tier.model,
              submenu: (cur, d) => textEdit("model", cur, d),
            },
            {
              id: "fallback",
              label: "fallback（逗号分隔）",
              description: "首选不可用时按顺序尝试的模型链",
              currentValue: tier.fallback.join(", "),
              submenu: (cur, d) => textEdit("fallback（逗号分隔）", cur, d),
            },
            {
              id: "delete",
              label: "🗑 删除此 tier",
              description: "从草稿移除，保存后才落盘",
              currentValue: "",
              values: ["确认删除"],
            },
          ];

          const detail = new SettingsList(
            fields,
            MAX_VISIBLE,
            getSettingsListTheme(),
            (id, value) => {
              if (id === "model") {
                tier.model = value.trim();
                dirty = true;
                detail.updateValue("model", tier.model);
              } else if (id === "fallback") {
                tier.fallback = splitList(value);
                dirty = true;
                detail.updateValue("fallback", tier.fallback.join(", "));
              } else if (id === "delete") {
                delete draft.tiers[name];
                dirty = true;
                const idx = rows.findIndex((r) => r.id === `tier:${name}`);
                if (idx >= 0) rows.splice(idx, 1);
                closeDetail(); // 不带值：已删除的行没有可回写的显示值
              }
            },
            // 带值关闭：顺手把父列表那一行的 model 显示刷新到最新
            () => closeDetail(tierValue(name)),
            { enableSearch: true },
          );
          return wrap(`tier: ${name}`, detail);
        }

        rows.push(...Object.keys(draft.tiers).map(tierRow));
        rows.push({
          id: "tier:add",
          label: "＋ 新增 tier",
          description: "输入新 tier 名，再进详情填 model / fallback",
          currentValue: "",
          submenu: (_cur, d) => textEdit("新 tier 名", "", d),
        });

        const list = new SettingsList(
          rows,
          MAX_VISIBLE,
          getSettingsListTheme(),
          (id, value) => {
            // 只处理新增；已有 tier 的修改都在 detail 内直接落草稿
            if (id !== "tier:add") return;
            const name = value.trim();
            if (!name) return;
            if (draft.tiers[name]) {
              ctx.ui.notify(`tier "${name}" 已存在，未覆盖`, "warning");
            } else {
              draft.tiers[name] = { model: "", fallback: [] };
              dirty = true;
              // 原地插到「＋ 新增」之前：rows 与 list 共享引用，无需重建列表
              rows.splice(rows.length - 1, 0, tierRow(name));
            }
            list.updateValue("tier:add", "");
          },
          () => closeList(),
          { enableSearch: true },
        );
        return wrap("tiers", list);
      };

      // ── modelSchedules ─────────────────────────────────────────────────────

      const scheduleValue = (model: string): string => {
        const entry = draft.modelSchedules[model];
        const parts: string[] = [];
        if (entry?.allow?.length) parts.push(`allow ${entry.allow.length}`);
        if (entry?.deny?.length) parts.push(`deny ${entry.deny.length}`);
        return parts.join(" · ") || "（空）";
      };

      const buildScheduleList = (
        closeList: (value?: string) => void,
      ): Component => {
        const rows: SettingItem[] = [];

        function scheduleRow(model: string): SettingItem {
          return {
            id: `sched:${model}`,
            label: model,
            currentValue: scheduleValue(model),
            submenu: (_cur, closeDetail) =>
              buildScheduleDetail(model, closeDetail),
          };
        }

        function buildScheduleDetail(
          model: string,
          closeDetail: (value?: string) => void,
        ): Component {
          const entry = draft.modelSchedules[model];
          if (!entry) {
            return goneNotice(`"${model}" 的时段配置已删除`, closeDetail);
          }

          const fields: SettingItem[] = [
            {
              id: "allow",
              label: "allow（逗号分隔）",
              description: "只在这些时段可用，如 22:00-08:00（跨午夜自动展开）",
              currentValue: (entry.allow ?? []).join(", "),
              submenu: (cur, d) => textEdit("allow（逗号分隔）", cur, d),
            },
            {
              id: "deny",
              label: "deny（逗号分隔）",
              description: "这些时段禁用，如 Mon-Fri 14:00-18:00",
              currentValue: (entry.deny ?? []).join(", "),
              submenu: (cur, d) => textEdit("deny（逗号分隔）", cur, d),
            },
            {
              id: "delete",
              label: "🗑 删除此模型时段",
              description: "从草稿移除，保存后才落盘",
              currentValue: "",
              values: ["确认删除"],
            },
          ];

          const detail = new SettingsList(
            fields,
            MAX_VISIBLE,
            getSettingsListTheme(),
            (id, value) => {
              if (id === "delete") {
                delete draft.modelSchedules[model];
                dirty = true;
                const idx = rows.findIndex((r) => r.id === `sched:${model}`);
                if (idx >= 0) rows.splice(idx, 1);
                closeDetail();
                return;
              }
              const values = splitList(value);
              // 空数组写 undefined：JSON 里不留 "allow": []，语义等于「该方向无限制」
              if (id === "allow") entry.allow = values.length ? values : undefined;
              else entry.deny = values.length ? values : undefined;
              dirty = true;
              detail.updateValue(id, values.join(", "));
            },
            () => closeDetail(scheduleValue(model)),
            { enableSearch: true },
          );
          return wrap(`modelSchedules: ${model}`, detail);
        }

        rows.push(...Object.keys(draft.modelSchedules).map(scheduleRow));
        rows.push({
          id: "sched:add",
          label: "＋ 新增模型时段",
          description: "输入模型名（如 zai/GLM-5.2），再进详情填 allow / deny",
          currentValue: "",
          submenu: (_cur, d) => textEdit("模型名", "", d),
        });

        const list = new SettingsList(
          rows,
          MAX_VISIBLE,
          getSettingsListTheme(),
          (id, value) => {
            if (id !== "sched:add") return;
            const model = value.trim();
            if (!model) return;
            if (draft.modelSchedules[model]) {
              ctx.ui.notify(`"${model}" 已有时段配置，未覆盖`, "warning");
            } else {
              draft.modelSchedules[model] = {};
              dirty = true;
              rows.splice(rows.length - 1, 0, scheduleRow(model));
            }
            list.updateValue("sched:add", "");
          },
          () => {
            // 离开时剪掉 allow/deny 全空的条目（新增后没填、或两侧都被清空）：
            // loadConfig 的 parseModelSchedules 读回来也会丢掉它们，留着只在
            // JSON 里生成 "model": {} 噪声
            for (const [model, entry] of Object.entries(draft.modelSchedules)) {
              if (!entry.allow?.length && !entry.deny?.length) {
                delete draft.modelSchedules[model];
              }
            }
            closeList();
          },
          { enableSearch: true },
        );
        return wrap("modelSchedules", list);
      };

      // ── 顶层列表 ───────────────────────────────────────────────────────────

      /** 子菜单只用 done() 关闭（不回写值），计数显示得手动刷新 */
      const refreshCounts = (): void => {
        settingsList.updateValue(
          "tiers",
          `${Object.keys(draft.tiers).length} tiers`,
        );
        settingsList.updateValue(
          "modelSchedules",
          `${Object.keys(draft.modelSchedules).length} models`,
        );
      };

      /** 数字字段：非整数 / 越界 → warn 且不改草稿，并把显示值回滚 */
      const applyNumber = (
        field:
          | "pollIntervalMs"
          | "keepResults"
          | "timeoutMs"
          | "maxTasks"
          | "maxConcurrency"
          | "idleGraceMs",
        raw: string,
      ): void => {
        const parsed = Number(raw.trim());
        const min = field === "keepResults" ? 0 : 1;
        if (!Number.isInteger(parsed) || parsed < min) {
          ctx.ui.notify(
            `${field} 需要 ≥ ${min} 的整数，已忽略「${raw}」`,
            "warning",
          );
        } else {
          draft[field] = parsed;
          dirty = true;
        }
        // 成功时是归一化（去空白），失败时是回滚
        settingsList.updateValue(field, String(draft[field]));
      };

      const items: SettingItem[] = [
        {
          id: "pollIntervalMs",
          label: "pollIntervalMs",
          description: "monitor 轮询 status.json 的间隔（毫秒）",
          currentValue: String(draft.pollIntervalMs),
          submenu: (cur, d) => textEdit("pollIntervalMs（毫秒）", cur, d),
        },
        {
          id: "panePrefix",
          label: "panePrefix",
          description: "pane 标题前缀（monitor 反解 agent 名也依赖它）",
          currentValue: draft.panePrefix,
          submenu: (cur, d) => textEdit("panePrefix", cur, d),
        },
        {
          id: "keepResults",
          label: "keepResults",
          description: "保留最近多少个 run 目录（0 = 不清理，全部保留）",
          currentValue: String(draft.keepResults),
          submenu: (cur, d) => textEdit("keepResults（个数）", cur, d),
        },
        {
          id: "timeoutMs",
          label: "timeoutMs",
          description: "单个 subagent 的超时（毫秒，1800000 = 30 分钟）",
          currentValue: String(draft.timeoutMs),
          submenu: (cur, d) => textEdit("timeoutMs（毫秒）", cur, d),
        },
        {
          id: "maxTasks",
          label: "maxTasks",
          description: "单次 parallel / chain 可提交的任务数上限",
          currentValue: String(draft.maxTasks),
          submenu: (cur, d) => textEdit("maxTasks（个数）", cur, d),
        },
        {
          id: "maxConcurrency",
          label: "maxConcurrency",
          description: "parallel 同时运行的 pane 数上限",
          currentValue: String(draft.maxConcurrency),
          submenu: (cur, d) => textEdit("maxConcurrency（个数）", cur, d),
        },
        {
          id: "defaultTier",
          label: "defaultTier",
          description:
            "agent 无 tier 时的回退（inherit = 继承前台模型）。可选值在面板打开时快照",
          currentValue: draft.defaultTier,
          values: [...Object.keys(draft.tiers), "inherit"],
        },
        {
          id: "tiers",
          label: "tiers ›",
          description: "tier 名 → model + fallback 链",
          currentValue: `${Object.keys(draft.tiers).length} tiers`,
          submenu: (_cur, d) =>
            buildTierList((value) => {
              refreshCounts();
              d(value);
            }),
        },
        {
          id: "modelSchedules",
          label: "modelSchedules ›",
          description: "按模型名的 allow / deny 时段限制（跨 tier 生效）",
          currentValue: `${Object.keys(draft.modelSchedules).length} models`,
          submenu: (_cur, d) =>
            buildScheduleList((value) => {
              refreshCounts();
              d(value);
            }),
        },
        {
          id: "autoClose",
          label: "autoClose",
          description:
            "completed 后空闲自动回收 pane（仅可 resume 的 peer；send 自动恢复会话）",
          currentValue: String(draft.autoClose),
          values: ["true", "false"],
        },
        {
          id: "idleGraceMs",
          label: "idleGraceMs",
          description: "autoClose 的空闲宽限期（毫秒，120000 = 2 分钟）",
          currentValue: String(draft.idleGraceMs),
          submenu: (cur, d) => textEdit("idleGraceMs（毫秒）", cur, d),
        },
        {
          id: "save",
          label: "💾 保存并应用",
          description: `写回 ${targetPath} 并热重载`,
          currentValue: "",
          values: ["保存"],
        },
      ];

      const settingsList = new SettingsList(
        items,
        MAX_VISIBLE,
        getSettingsListTheme(),
        (id, value) => {
          switch (id) {
            case "pollIntervalMs":
            case "keepResults":
            case "timeoutMs":
            case "maxTasks":
            case "maxConcurrency":
            case "idleGraceMs":
              applyNumber(id, value);
              break;
            case "panePrefix":
              draft.panePrefix = value;
              dirty = true;
              break;
            case "autoClose":
              draft.autoClose = value === "true";
              dirty = true;
              break;
            case "defaultTier":
              draft.defaultTier = value;
              dirty = true;
              break;
            case "save":
              try {
                saveConfig(draft);
              } catch (err) {
                ctx.ui.notify(
                  `❌ 保存失败: ${err instanceof Error ? err.message : String(err)}`,
                  "error",
                );
                settingsList.updateValue("save", "");
                return;
              }
              // 返回 loadConfig() 而非 draft：调用方拿到的是「磁盘 → 解析」后的
              // 归一化结果，与扩展启动时的加载路径完全一致
              done(loadConfig());
              break;
            default:
              break;
          }
        },
        () => {
          if (dirty) ctx.ui.notify("已放弃未保存的配置修改", "warning");
          done(null);
        },
        { enableSearch: true },
      );

      const container = new Container();
      container.addChild(
        new Text(theme.fg("accent", theme.bold("atelier 配置")), 1, 1),
      );
      container.addChild(
        new Text(
          theme.fg("dim", `↑↓ 导航 · Enter 编辑 · Esc 放弃 · ${targetPath}`),
          1,
          0,
        ),
      );
      container.addChild(settingsList);

      return {
        render: (w) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data) => settingsList.handleInput?.(data),
      };
    },
  );
}
