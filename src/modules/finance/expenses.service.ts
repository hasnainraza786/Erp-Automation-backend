import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthUser } from '../../common/auth.decorators';
import { D, money } from '../../common/money';
import { dateRangeWhere, pageArgs, pageMeta } from '../../common/schemas';
import { AuditService } from '../../infra/audit.service';
import { cashAccountFor, EXPENSE_CATEGORY_ACCOUNT, JournalService } from '../../infra/journal.service';
import { NumberingService } from '../../infra/numbering.service';
import { PrismaService } from '../../infra/prisma.service';
import { CreateExpenseDto, ExpenseQueryDto } from './finance.schemas';

const include = {
  vendor: { select: { id: true, name: true } },
  project: { select: { id: true, number: true, name: true } },
} satisfies Prisma.ExpenseInclude;

@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: NumberingService,
    private readonly audit: AuditService,
    private readonly journal: JournalService,
  ) {}

  private present(e: Prisma.ExpenseGetPayload<{ include: typeof include }>) {
    return {
      id: e.id,
      number: e.number,
      expenseDate: e.expenseDate.toISOString(),
      category: e.category as 'TRANSPORT',
      amount: money(e.amount),
      method: e.method,
      description: e.description,
      payee: e.payee,
      notes: e.notes,
      status: e.status,
      voidReason: e.voidReason,
      vendor: e.vendor,
      project: e.project,
      createdAt: e.createdAt.toISOString(),
    };
  }

  async list(q: ExpenseQueryDto) {
    const where: Prisma.ExpenseWhereInput = {
      category: q.category,
      projectId: q.projectId,
      siteId: q.siteId,
      vendorId: q.vendorId,
      status: q.status,
      expenseDate: dateRangeWhere(q),
      ...(q.q
        ? { OR: [{ number: { contains: q.q, mode: 'insensitive' } }, { description: { contains: q.q, mode: 'insensitive' } }, { payee: { contains: q.q, mode: 'insensitive' } }] }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.expense.findMany({ where, include, orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }], ...pageArgs(q) }),
      this.prisma.expense.count({ where }),
    ]);
    return { data: rows.map((r) => this.present(r)), meta: pageMeta(q, total) };
  }

  async create(user: AuthUser, body: CreateExpenseDto) {
    const amount = D(body.amount);
    if (amount.lte(0)) throw new BadRequestException('Amount must be greater than zero');
    return this.prisma.tx(async (tx) => {
      let siteId: string | null = null;
      let clientId: string | null = null;
      if (body.projectId) {
        const project = await tx.project.findUnique({ where: { id: body.projectId } });
        if (!project) throw new NotFoundException('Project not found');
        siteId = project.siteId;
        clientId = project.clientId;
      }
      const number = await this.numbering.next(tx, 'EXPENSE', body.expenseDate);
      const e = await tx.expense.create({
        data: { ...body, amount: money(amount), number, siteId, createdBy: user.id },
        include,
      });
      await this.journal.post(tx, {
        date: body.expenseDate,
        description: `${body.category.replace('_', ' ').toLowerCase()} expense${body.description ? `: ${body.description}` : ''}`,
        sourceType: 'EXPENSE',
        sourceId: e.id,
        reference: number,
        createdBy: user.id,
        lines: [
          { account: EXPENSE_CATEGORY_ACCOUNT[body.category], debit: amount, projectId: body.projectId, siteId, clientId, vendorId: body.vendorId },
          { account: cashAccountFor(body.method), credit: amount, vendorId: body.vendorId },
        ],
      });
      await this.audit.log(user, { action: 'expense.created', entityType: 'Expense', entityId: e.id, summary: `${number}: PKR ${money(amount)} ${body.category}${e.project ? ` for ${e.project.number}` : ''}` }, tx);
      return this.present(e);
    });
  }

  async void(user: AuthUser, id: string, reason: string) {
    return this.prisma.tx(async (tx) => {
      const e = await tx.expense.findUnique({ where: { id } });
      if (!e) throw new NotFoundException('Expense not found');
      if (e.status === 'VOIDED') throw new BadRequestException('Expense already voided');
      await this.journal.reverseSource(tx, 'EXPENSE', id, reason, user.id);
      const updated = await tx.expense.update({ where: { id }, data: { status: 'VOIDED', voidReason: reason }, include });
      await this.audit.log(user, { action: 'expense.voided', entityType: 'Expense', entityId: id, summary: `${e.number} voided: ${reason}` }, tx);
      return this.present(updated);
    });
  }
}
