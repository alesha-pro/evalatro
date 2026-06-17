import { z } from "zod";

/** Wire-format version of the submission payload. */
export const SCHEMA_VERSION = 1;

/** One move as submitted. `state` is the pre-move SummarizedState (validated
 *  structurally by the scorer, not field-by-field here). */
export const MoveSubmissionSchema = z.object({
  step: z.number().int().optional(),
  ts: z.number().int().optional(),
  state: z.any(),
  tool: z.string().max(60),
  args: z.record(z.any()).optional(),
  reasoning: z.string().optional(),
  illegal: z.string().nullable().optional(),
  finishReason: z.string().nullable().optional(),
  diagnostic: z.record(z.any()).optional(),
  tokensIn: z.number().optional(),
  tokensOut: z.number().optional(),
  costUsd: z.number().optional(),
});

export const RunRecordSchema = z.object({
  gameId: z.string().max(200),
  model: z.string().max(120),
  seed: z.string().max(60),
  deck: z.string().max(40),
  stake: z.string().max(40),
  targetAnte: z.number().int().optional(),
  maxAnte: z.number(),
  finalRound: z.number(),
  finalMoney: z.number(),
  won: z.boolean(),
  outcome: z.string().max(20),
  score: z.number(),
  actions: z.number(),
  illegalActions: z.number(),
  durationMs: z.number(),
  tokensIn: z.number(),
  tokensOut: z.number(),
  costUsd: z.number(),
  error: z.string().nullable(),
  ts: z.number(),
});

export const SubmissionSchema = z.object({
  schemaVersion: z.number().int(),
  evalVersion: z.string().max(20),
  codeHash: z.string().max(120),
  submittedAt: z.number().int(),
  submitter: z.string().max(40).optional(),
  model: z.object({
    name: z.string().max(120),
    baseURLHost: z.string().max(200),
    modelId: z.string().max(200),
    mode: z.enum(["tools", "json"]),
  }),
  config: z.object({
    deck: z.string().max(40),
    stake: z.string().max(40),
    seed: z.string().max(60),
    targetAnte: z.number().int().optional(),
  }),
  runRecord: RunRecordSchema,
  finalState: z.any().optional(),
  moves: z.array(MoveSubmissionSchema).max(5000),
  clientMeta: z.object({
    os: z.string().max(120).optional(),
    runnerVersion: z.string().max(40).optional(),
    nodeVersion: z.string().max(40).optional(),
    startedAt: z.number().optional(),
    endedAt: z.number().optional(),
  }),
});

export type Submission = z.infer<typeof SubmissionSchema>;
export type MoveSubmission = z.infer<typeof MoveSubmissionSchema>;
