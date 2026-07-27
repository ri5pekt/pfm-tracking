/** Shared internal → friendly labels (docs/dev-plan.md §4). */
export const STATUS_LABELS: Record<string, string> = {
  ORDER_RECEIVED: 'Order confirmed',
  PROCESSING: 'Preparing',
  LABEL_CREATED: 'Label created',
  IN_TRANSIT: 'In transit',
  OUT_FOR_DELIVERY: 'Out for delivery',
  EXCEPTION: 'Exception',
  DELIVERED: 'Delivered',
  RETURNED_TO_SENDER: 'Returning',
  CANCELLED: 'Cancelled',
};

export function statusLabel(internal: string | null | undefined): string {
  if (!internal) return 'Unknown';
  return STATUS_LABELS[internal] ?? internal.replaceAll('_', ' ').toLowerCase();
}

/** CSS modifier for colored status tags */
export function statusTone(internal: string | null | undefined): string {
  switch (internal) {
    case 'DELIVERED':
      return 'ok';
    case 'EXCEPTION':
    case 'RETURNED_TO_SENDER':
      return 'warn';
    case 'CANCELLED':
      return 'danger';
    case 'OUT_FOR_DELIVERY':
      return 'accent';
    case 'IN_TRANSIT':
      return 'info';
    case 'LABEL_CREATED':
    case 'PROCESSING':
    case 'ORDER_RECEIVED':
      return 'neutral';
    default:
      return 'neutral';
  }
}
