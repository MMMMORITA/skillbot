export declare function enterSkillsMode(panel: any): void;
export declare function exitSkillsMode(panel: any): void;
export declare function renderSkillList(panel: any, skills: Array<{
    name: string;
    description: string;
    enabled: boolean;
    body?: string;
    category?: string;
}>): void;
/** Open the browser file picker and upload the chosen .zip as a skill. */
export declare function promptUploadSkill(panel: any): void;
/** Restart the agent session so enable/disable changes take effect. */
export declare function restartAgent(panel: any): void;
export declare function onSkillKeydown(panel: any, e: KeyboardEvent): void;
export declare function refreshSkillRows(panel: any): void;
/** Optimistically flip a skill, tell the backend, and note it needs a restart. */
export declare function toggleSkill(panel: any, idx: number): void;
/** Uninstall a skill after an inline confirm click. */
export declare function uninstallSkill(panel: any, idx: number): void;
export declare function updateSkillHint(panel: any): void;
/** Flash a short backend message (upload/uninstall result) above the list. */
export declare function showSkillNotice(panel: any, msg: string): void;
export declare function renderSkillInfo(panel: any, skill: {
    name: string;
    description: string;
    enabled: boolean;
    body: string;
    path: string;
}): void;
