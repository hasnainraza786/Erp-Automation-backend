import { BadRequestException, Injectable } from '@nestjs/common';
import { InventoryTxnType } from '@prisma/client';
import { D, qty, type DecimalInput, Decimal } from '../common/money';
import { Tx } from './prisma.service';

interface Move {
  productId: string;
  qty: DecimalInput;
  projectId?: string | null;
  unitCost?: DecimalInput;
  refType?: string;
  refId?: string;
  notes?: string;
  userId?: string;
}

/**
 * All stock changes go through here: an append-only InventoryTransaction log plus the
 * ProductStock cache (on hand, reserved, incoming), updated in the same transaction.
 */
@Injectable()
export class StockService {
  async ensure(tx: Tx, productId: string) {
    return tx.productStock.upsert({ where: { productId }, create: { productId }, update: {} });
  }

  async available(tx: Tx, productId: string): Promise<Decimal> {
    const s = await this.ensure(tx, productId);
    return D(s.onHand).minus(D(s.reserved));
  }

  private async log(tx: Tx, type: InventoryTxnType, m: Move) {
    await tx.inventoryTransaction.create({
      data: {
        productId: m.productId,
        projectId: m.projectId ?? undefined,
        type,
        qty: qty(m.qty),
        unitCost: m.unitCost === undefined ? undefined : D(m.unitCost).toFixed(2),
        refType: m.refType,
        refId: m.refId,
        notes: m.notes,
        createdBy: m.userId,
      },
    });
  }

  async addIncoming(tx: Tx, productId: string, amount: DecimalInput) {
    const s = await this.ensure(tx, productId);
    const next = Decimal.max(0, D(s.incoming).plus(D(amount)));
    await tx.productStock.update({ where: { productId }, data: { incoming: qty(next) } });
  }

  async receive(tx: Tx, m: Move) {
    const s = await this.ensure(tx, m.productId);
    await tx.productStock.update({
      where: { productId: m.productId },
      data: {
        onHand: qty(D(s.onHand).plus(D(m.qty))),
        incoming: qty(Decimal.max(0, D(s.incoming).minus(D(m.qty)))),
      },
    });
    await this.log(tx, 'RECEIPT', m);
  }

  /** Reserves up to the requested quantity from available stock; returns the amount reserved. */
  async reserve(tx: Tx, m: Move): Promise<Decimal> {
    const s = await this.ensure(tx, m.productId);
    const available = Decimal.max(0, D(s.onHand).minus(D(s.reserved)));
    const amount = Decimal.min(available, D(m.qty));
    if (amount.lte(0)) return new Decimal(0);
    await tx.productStock.update({
      where: { productId: m.productId },
      data: { reserved: qty(D(s.reserved).plus(amount)) },
    });
    await this.log(tx, 'RESERVE', { ...m, qty: amount });
    return amount;
  }

  async release(tx: Tx, m: Move) {
    const s = await this.ensure(tx, m.productId);
    const amount = Decimal.min(D(s.reserved), D(m.qty));
    if (amount.lte(0)) return;
    await tx.productStock.update({
      where: { productId: m.productId },
      data: { reserved: qty(D(s.reserved).minus(amount)) },
    });
    await this.log(tx, 'RELEASE', { ...m, qty: amount });
  }

  /** Issues stock out of the warehouse (delivery to site). Consumes the project's reservation first. */
  async issue(tx: Tx, m: Move & { fromReserved: DecimalInput }) {
    const s = await this.ensure(tx, m.productId);
    const amount = D(m.qty);
    if (D(s.onHand).lt(amount)) {
      throw new BadRequestException(`Insufficient stock: on hand ${D(s.onHand).toFixed(3)}, requested ${amount.toFixed(3)}`);
    }
    const fromReserved = Decimal.min(D(m.fromReserved), amount, D(s.reserved));
    const freeNeeded = amount.minus(fromReserved);
    const free = D(s.onHand).minus(D(s.reserved));
    if (free.lt(freeNeeded)) {
      throw new BadRequestException('Stock is reserved for other projects');
    }
    await tx.productStock.update({
      where: { productId: m.productId },
      data: { onHand: qty(D(s.onHand).minus(amount)), reserved: qty(D(s.reserved).minus(fromReserved)) },
    });
    await this.log(tx, 'ISSUE', m);
    return fromReserved;
  }

  async adjust(tx: Tx, m: Move) {
    const s = await this.ensure(tx, m.productId);
    const next = D(s.onHand).plus(D(m.qty));
    if (next.lt(D(s.reserved))) throw new BadRequestException('Adjustment would leave less stock than reserved');
    await tx.productStock.update({ where: { productId: m.productId }, data: { onHand: qty(next) } });
    await this.log(tx, 'ADJUSTMENT', m);
  }
}
