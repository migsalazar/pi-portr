import assert from "node:assert/strict";
import test from "node:test";
import {
  createDestinationPane,
  type Orchestrator,
  PaneLimitReachedError,
  type PaneLayout,
  type SplitPaneOptions,
} from "../src/orchestrator.ts";

test("createDestinationPane splits the longer visual side", async () => {
  for (const scenario of [
    {
      layout: { paneCount: 1, origin: { width: 181, height: 58 } },
      direction: "right" as const,
    },
    {
      layout: { paneCount: 2, origin: { width: 91, height: 58 } },
      direction: "down" as const,
    },
    {
      layout: { paneCount: 3, origin: { width: 91, height: 29 } },
      direction: "right" as const,
    },
  ]) {
    const splits: unknown[] = [];
    const orchestrator = fakeOrchestrator(scenario.layout, splits);

    assert.equal(
      await createDestinationPane(orchestrator, {
        originPaneId: "w1:p1",
        cwd: "/tmp/project",
        maxPanes: 4,
      }),
      "w1:p2",
    );
    assert.deepEqual(splits, [
      {
        paneId: "w1:p1",
        cwd: "/tmp/project",
        direction: scenario.direction,
      },
    ]);
  }
});

test("createDestinationPane refuses before mutation at the configured limit", async () => {
  const splits: unknown[] = [];
  const orchestrator = fakeOrchestrator(
    { paneCount: 4, origin: { width: 91, height: 29 } },
    splits,
  );

  await assert.rejects(
    () =>
      createDestinationPane(orchestrator, {
        originPaneId: "w1:p1",
        cwd: "/tmp/project",
        maxPanes: 4,
      }),
    (error: unknown) => {
      assert.ok(error instanceof PaneLimitReachedError);
      assert.equal(error.code, "pane_limit_reached");
      assert.equal(error.currentPanes, 4);
      assert.equal(error.maxPanes, 4);
      assert.equal(error.retryable, false);
      assert.match(error.message, /\/portr-settings/);
      return true;
    },
  );
  assert.deepEqual(splits, []);
});

function fakeOrchestrator(layout: PaneLayout, splits: unknown[]): Orchestrator {
  return {
    paneLayout: async () => layout,
    splitPane: async (options: SplitPaneOptions) => {
      splits.push(options);
      return "w1:p2";
    },
  } as unknown as Orchestrator;
}
