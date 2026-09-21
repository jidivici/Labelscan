export type WorkflowKind = 'fresh' | 'receipt' | 'temp' | 'tank' | 'clean' | 'cook' | 'probe';
export type Answer = string | boolean;
export type Answers = Record<string, Answer | undefined>;
export interface WorkflowField {
 key: string; label: string; type: 'text' | 'textarea' | 'date' | 'datetime-local' | 'number' | 'radio' | 'checkbox';
 required: boolean; options?: string[]; help?: string; min?: number; step?: number | string;
}
export interface WorkflowStep { id: string; title: string; doText: string; source: string; fields: WorkflowField[]; note?: string; branch?: string; }
export interface HygieneWorkflow {
 data(): Answers;
 steps(): WorkflowStep[];
 fields(step: WorkflowStep): WorkflowField[];
 validate(step: WorkflowStep): string[];
 validateAll(): string[];
 notes(stepId: string): string[];
 update(key: string, value: Answer, stepId: string): void;
 hasIssue(): boolean;
 unfinished(): boolean;
}
export function createHygieneWorkflow(kind: WorkflowKind, initial?: Answers): HygieneWorkflow;
