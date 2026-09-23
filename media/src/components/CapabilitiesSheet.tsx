import type { JSX } from "react";
import type { PluginInfo, SkillInfo } from "../../../src/shared/protocol";
import { Icon } from "./Icons";

export type CapabilitiesTab = "skills" | "plugins";

export interface CapabilitiesSheetProps {
  readonly tab: CapabilitiesTab;
  readonly skills: readonly SkillInfo[];
  readonly skillsLoaded: boolean;
  readonly plugins: readonly PluginInfo[];
  readonly pluginsLoaded: boolean;
  readonly onTab: (tab: CapabilitiesTab) => void;
  /** Put a slash command into the composer, e.g. `/skill:brave-search `. */
  readonly onUse: (text: string) => void;
  readonly onClose: () => void;
}

/** Read-only view of pi's skills and plugins (`/skills`, `/plugins`). */
export function CapabilitiesSheet(props: CapabilitiesSheetProps): JSX.Element {
  const { tab } = props;
  const loading = tab === "skills" ? !props.skillsLoaded : !props.pluginsLoaded;

  return (
    <div className="dialog-mask" onClick={props.onClose}>
      <div className="sheet capabilities-sheet" onClick={(event) => event.stopPropagation()}>
        <div className="sheet-head">
          <Icon name="chip" size={15} />
          <h2>Skills &amp; plugins</h2>
          <button type="button" className="icon-btn" title="Close" onClick={props.onClose}>
            <Icon name="close" size={15} />
          </button>
        </div>

        <div className="sheet-tabs">
          <button
            type="button"
            className={tab === "skills" ? "active" : ""}
            onClick={() => props.onTab("skills")}
          >
            Skills{props.skillsLoaded ? ` (${props.skills.length})` : ""}
          </button>
          <button
            type="button"
            className={tab === "plugins" ? "active" : ""}
            onClick={() => props.onTab("plugins")}
          >
            Plugins{props.pluginsLoaded ? ` (${props.plugins.length})` : ""}
          </button>
        </div>

        {loading && <div className="popover-empty">Loading…</div>}

        {!loading && tab === "skills" && (
          <>
            {props.skills.length === 0 && (
              <div className="popover-empty">
                No skills found. Add one under <code>~/.pi/agent/skills/</code> or <code>.pi/skills/</code>.
              </div>
            )}
            <div className="capability-list">
              {props.skills.map((skill) => (
                <button
                  key={skill.name}
                  type="button"
                  className="capability-row"
                  title={skill.path ?? skill.name}
                  onClick={() => props.onUse(`/skill:${skill.name} `)}
                >
                  <div className="capability-row-head">
                    <span className="capability-name">{skill.name}</span>
                    {skill.location !== undefined && (
                      <span className={`capability-badge ${skill.location}`}>{skill.location}</span>
                    )}
                    <Icon name="chevron-right" size={13} />
                  </div>
                  {skill.description !== undefined && (
                    <span className="capability-desc">{skill.description}</span>
                  )}
                  {skill.path !== undefined && <span className="capability-path">{skill.path}</span>}
                </button>
              ))}
            </div>
          </>
        )}

        {!loading && tab === "plugins" && (
          <>
            {props.plugins.length === 0 && (
              <div className="popover-empty">
                No packages or extensions configured. Install one with <code>pi install &lt;package&gt;</code>.
              </div>
            )}
            <div className="capability-list">
              {props.plugins.map((plugin, index) => (
                <div key={`${plugin.kind}-${plugin.name}-${index}`} className="capability-row static">
                  <div className="capability-row-head">
                    <span className="capability-name">{plugin.name}</span>
                    <span className={`capability-badge kind-${plugin.kind}`}>{plugin.kind}</span>
                    <span className={`capability-badge ${plugin.scope}`}>{plugin.scope}</span>
                    {plugin.kind === "command" && (
                      <button
                        type="button"
                        className="icon-btn"
                        title="Insert command"
                        onClick={() => props.onUse(plugin.name)}
                      >
                        <Icon name="chevron-right" size={13} />
                      </button>
                    )}
                  </div>
                  {plugin.detail !== undefined && <span className="capability-desc">{plugin.detail}</span>}
                  {plugin.path !== undefined && <span className="capability-path">{plugin.path}</span>}
                </div>
              ))}
            </div>
          </>
        )}

        <p className="sheet-note">
          Skills come from pi's <code>get_commands</code> (<code>~/.pi/agent/skills</code>,{" "}
          <code>.pi/skills</code>, installed packages). Plugins are read from{" "}
          <code>~/.pi/agent/settings.json</code> and <code>.pi/settings.json</code> plus the commands the
          running engine reports.
        </p>
      </div>
    </div>
  );
}
