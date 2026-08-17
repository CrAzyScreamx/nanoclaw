/**
 * Looking back at one week: what was on the list against what was actually
 * bought.
 *
 * Reads closed weeks as freely as the open one — closing a week keeps its items
 * precisely so that history stays queryable.
 */
import { emit, flag, type CommandContext, type CommandSpec } from '../lib/cli.ts';
import { loadPack, t } from '../lib/locale.ts';
import { lineMark, renderNumbered, renderPlain, withPositions } from '../lib/render.ts';
import { itemsInWeek, resolveWeek } from '../lib/weeks.ts';

export const reportCommand: CommandSpec = {
  name: 'report',
  summary: 'One week in detail: everything on it, bought and not bought.',
  usage: 'grocery.ts report [--week current|last|<id>] [--json]',
  async run(ctx: CommandContext) {
    const pack = loadPack();
    const week = resolveWeek(flag(ctx.args, 'week'));
    if (!week) {
      emit(ctx, null, () => console.log(t(pack, 'noSuchWeek')));
      return;
    }

    const all = itemsInWeek(week);
    const bought = all.filter((item) => item.status === 'bought');
    const pending = all.filter((item) => item.status === 'pending');
    const payload = {
      week: { id: week.id, week_start: week.week_start, status: week.status },
      total: all.length,
      bought_count: bought.length,
      pending_count: pending.length,
      // `bought` carries NO `n`, on purpose. Only the pending list is a `--n`
      // target — `mark-bought` acts on pending items — so numbering both would
      // put two different number spaces in one message and make "number 3"
      // ambiguous. Bought items are shown by name.
      bought,
      pending: withPositions(pending),
    };

    emit(ctx, payload, (data) => {
      const mark = lineMark(pack);
      console.log(
        `${mark}${t(pack, 'weekSummary', {
          week: data.week.week_start,
          total: data.total,
          bought: data.bought_count,
          pending: data.pending_count,
        })}`,
      );
      // The section labels come from the pack so nothing in another language
      // can leak into the chat if the agent relays this output rather than
      // rewriting it.
      console.log(`\n${mark}${t(pack, 'sectionBought')}`);
      console.log(renderPlain(data.bought, pack));
      console.log(`\n${mark}${t(pack, 'sectionNotBought')}`);
      console.log(renderNumbered(data.pending, pack));
    });
  },
};
