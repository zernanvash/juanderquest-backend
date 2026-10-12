import adminRouter from '../src/routes/admin.js';
import { submissionsService } from '../src/services/submissions.js';

describe('admin pilot award response', () => {
  it('passes through the committed award receipt on approval replay', async () => {
    const review = jest.spyOn(submissionsService, 'reviewSubmission').mockResolvedValue({
      success: true,
      statusCode: 200,
      data: {
        submission: { id: 'reviewed-sub', status: 'approved' } as any,
        awarded_points: 0,
        awarded_explorer_coins: '100',
        explorer_coin_transaction_id: 'committed-transfer',
      },
    });
    const route = (adminRouter as any).stack.find(
      (layer: any) => layer.route?.path === '/admin/submissions/:id' && layer.route?.methods?.patch
    );
    expect(route).toBeDefined();
    const handler = route.route.stack[route.route.stack.length - 1].handle;
    const req = { params: { id: 'reviewed-sub' }, body: { action: 'approve' }, user: { id: 'admin' } };
    const res: any = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    try {
      await handler(req, res);
      expect(review).toHaveBeenCalledWith('reviewed-sub', 'approve', 'admin', undefined);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: {
          id: 'reviewed-sub', status: 'approved', awarded_points: 0,
          awarded_explorer_coins: '100', explorer_coin_transaction_id: 'committed-transfer',
        },
      });
    } finally {
      review.mockRestore();
    }
  });
});
