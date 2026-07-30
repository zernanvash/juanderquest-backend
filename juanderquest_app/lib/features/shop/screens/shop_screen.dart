import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import '../../auth/providers/auth_provider.dart';

class ShopScreen extends ConsumerWidget {
  const ShopScreen({super.key});

  void _showVoucherConfirmationDialog({
    required BuildContext context,
    required String merchantName,
    required String offerTitle,
    required int costPoints,
    required int userPoints,
  }) {
    final remainingPoints = userPoints - costPoints;

    showDialog(
      context: context,
      builder: (dialogCtx) => Dialog(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        backgroundColor: const Color(0xFFFAF9F5),
        child: Padding(
          padding: const EdgeInsets.all(24.0),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 60,
                height: 60,
                decoration: const BoxDecoration(
                  color: Color(0xFFBEEAD1),
                  shape: BoxShape.circle,
                ),
                child: const Icon(Icons.confirmation_number_rounded, color: Color(0xFF2D6A4F), size: 32),
              ),
              const SizedBox(height: 16),
              Text(
                'Redeem Voucher?',
                textAlign: TextAlign.center,
                style: GoogleFonts.epilogue(
                  color: const Color(0xFF582F0E),
                  fontSize: 20,
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                'You are about to redeem "$offerTitle" from $merchantName.',
                textAlign: TextAlign.center,
                style: GoogleFonts.plusJakartaSans(
                  color: const Color(0xFF514532),
                  fontSize: 13,
                  height: 1.4,
                ),
              ),
              const SizedBox(height: 16),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: const Color(0xFFD5C4AC).withValues(alpha: 0.4)),
                ),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(
                      'Cost Deduction:',
                      style: GoogleFonts.plusJakartaSans(color: const Color(0xFF837560), fontSize: 12),
                    ),
                    Text(
                      '-$costPoints PTS',
                      style: GoogleFonts.plusJakartaSans(
                        color: const Color(0xFFBC4749),
                        fontWeight: FontWeight.bold,
                        fontSize: 13,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 8),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: const Color(0xFFD5C4AC).withValues(alpha: 0.4)),
                ),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(
                      'Remaining Balance:',
                      style: GoogleFonts.plusJakartaSans(color: const Color(0xFF837560), fontSize: 12),
                    ),
                    Text(
                      '$remainingPoints PTS',
                      style: GoogleFonts.plusJakartaSans(
                        color: const Color(0xFF7D5800),
                        fontWeight: FontWeight.bold,
                        fontSize: 13,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 24),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: () => Navigator.of(dialogCtx).pop(),
                      style: OutlinedButton.styleFrom(
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                        side: const BorderSide(color: Color(0xFFD5C4AC)),
                      ),
                      child: Text('Cancel', style: GoogleFonts.epilogue(color: const Color(0xFF514532))),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: ElevatedButton(
                      onPressed: () {
                        Navigator.of(dialogCtx).pop();
                        ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(
                            content: Text(
                              'Voucher "$offerTitle" redeemed! Present code JDQ-VOUCHER-2026 to merchant.',
                              style: GoogleFonts.plusJakartaSans(),
                            ),
                            backgroundColor: const Color(0xFF2D6A4F),
                          ),
                        );
                      },
                      style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFFFFB703),
                        foregroundColor: const Color(0xFF6B4B00),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                      ),
                      child: Text('Confirm', style: GoogleFonts.epilogue(fontWeight: FontWeight.bold)),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(authProvider).user;
    final points = user?.demoPoints ?? 0;

    return Scaffold(
      backgroundColor: const Color(0xFFFAF9F5),
      appBar: AppBar(
        backgroundColor: const Color(0xFFFAF9F5),
        elevation: 0,
        scrolledUnderElevation: 0,
        title: Text(
          'Merchant Voucher Store',
          style: GoogleFonts.epilogue(
            color: const Color(0xFF582F0E),
            fontSize: 20,
            fontWeight: FontWeight.bold,
          ),
        ),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Points Balance Banner
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: const Color(0xFFFFB703)),
                boxShadow: [
                  BoxShadow(
                    color: const Color(0xFFFFB703).withValues(alpha: 0.15),
                    blurRadius: 12,
                    offset: const Offset(0, 4),
                  ),
                ],
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'AVAILABLE REWARDS',
                          style: GoogleFonts.plusJakartaSans(
                            color: const Color(0xFF837560),
                            fontSize: 10,
                            fontWeight: FontWeight.bold,
                            letterSpacing: 1.0,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          'Demo Points Balance',
                          style: GoogleFonts.epilogue(
                            color: const Color(0xFF582F0E),
                            fontSize: 16,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                      ],
                    ),
                  ),
                  Row(
                    children: [
                      Image.asset(
                        'assets/images/jdq-token.png',
                        width: 28,
                        height: 28,
                        errorBuilder: (_, __, ___) => const Icon(Icons.stars, color: Color(0xFFFFB703), size: 28),
                      ),
                      const SizedBox(width: 8),
                      Text(
                        '$points PTS',
                        style: GoogleFonts.epilogue(
                          color: const Color(0xFF7D5800),
                          fontSize: 24,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: 24),

            Text(
              'Pangasinan Partner Merchants',
              style: GoogleFonts.epilogue(
                color: const Color(0xFF0D1B2A),
                fontSize: 18,
                fontWeight: FontWeight.bold,
              ),
            ),
            const SizedBox(height: 12),

            _buildVoucherCard(
              context: context,
              merchantName: 'Dagupan Bangus Grill & Restaurant',
              offerTitle: '₱100 Meal Discount Voucher',
              costPoints: 50,
              userPoints: points,
              category: 'FOOD & DINING',
              location: 'Dagupan City, Pangasinan',
            ),
            const SizedBox(height: 12),
            _buildVoucherCard(
              context: context,
              merchantName: 'Hundred Islands Boatmen Association',
              offerTitle: '15% Off Island Hopping Tour',
              costPoints: 75,
              userPoints: points,
              category: 'ECO-TOURISM',
              location: 'Alaminos City, Pangasinan',
            ),
            const SizedBox(height: 12),
            _buildVoucherCard(
              context: context,
              merchantName: 'Bolinao Souvenirs & Crafts',
              offerTitle: 'Free Heritage Gift Token',
              costPoints: 40,
              userPoints: points,
              category: 'TRADE & CRAFTS',
              location: 'Bolinao, Pangasinan',
            ),
          ],
        ),
      ),
      bottomNavigationBar: Container(
        decoration: BoxDecoration(
          color: Colors.white,
          border: Border(top: BorderSide(color: const Color(0xFFD5C4AC).withValues(alpha: 0.4))),
        ),
        child: BottomNavigationBar(
          backgroundColor: Colors.white,
          selectedItemColor: const Color(0xFF3F6653),
          unselectedItemColor: const Color(0xFF837560),
          currentIndex: 3,
          type: BottomNavigationBarType.fixed,
          elevation: 0,
          onTap: (index) {
            if (index == 0) context.go('/quests');
            if (index == 1) context.go('/map');
            if (index == 2) context.go('/vote');
            if (index == 4) context.go('/profile');
          },
          items: const [
            BottomNavigationBarItem(icon: Icon(Icons.home_rounded), label: 'Home'),
            BottomNavigationBarItem(icon: Icon(Icons.map_rounded), label: 'Map'),
            BottomNavigationBarItem(icon: Icon(Icons.how_to_vote_rounded), label: 'Vote'),
            BottomNavigationBarItem(icon: Icon(Icons.storefront_rounded), label: 'Shop'),
            BottomNavigationBarItem(icon: Icon(Icons.person_rounded), label: 'Profile'),
          ],
        ),
      ),
    );
  }

  Widget _buildVoucherCard({
    required BuildContext context,
    required String merchantName,
    required String offerTitle,
    required int costPoints,
    required int userPoints,
    required String category,
    required String location,
  }) {
    final canAfford = userPoints >= costPoints;

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFD5C4AC).withValues(alpha: 0.4)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: const Color(0xFF3F6653).withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  category,
                  style: GoogleFonts.plusJakartaSans(
                    color: const Color(0xFF3F6653),
                    fontSize: 9,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
              Row(
                children: [
                  Image.asset(
                    'assets/images/jdq-token.png',
                    width: 16,
                    height: 16,
                    errorBuilder: (_, __, ___) => const Icon(Icons.stars, color: Color(0xFFFFB703), size: 14),
                  ),
                  const SizedBox(width: 4),
                  Text(
                    '$costPoints PTS',
                    style: GoogleFonts.plusJakartaSans(
                      color: const Color(0xFF7D5800),
                      fontWeight: FontWeight.bold,
                      fontSize: 13,
                    ),
                  ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            offerTitle,
            style: GoogleFonts.epilogue(
              color: const Color(0xFF582F0E),
              fontSize: 16,
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            merchantName,
            style: GoogleFonts.plusJakartaSans(color: const Color(0xFF1B1C1A), fontSize: 13, fontWeight: FontWeight.w600),
          ),
          Text(
            location,
            style: GoogleFonts.plusJakartaSans(color: const Color(0xFF837560), fontSize: 12),
          ),
          const SizedBox(height: 14),
          ElevatedButton(
            onPressed: canAfford
                ? () => _showVoucherConfirmationDialog(
                      context: context,
                      merchantName: merchantName,
                      offerTitle: offerTitle,
                      costPoints: costPoints,
                      userPoints: userPoints,
                    )
                : null,
            style: ElevatedButton.styleFrom(
              minimumSize: const Size.fromHeight(42),
              backgroundColor: const Color(0xFFFFB703),
              foregroundColor: const Color(0xFF6B4B00),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            ),
            child: Text(
              canAfford ? 'Redeem Voucher' : 'Insufficient Demo Points',
              style: GoogleFonts.epilogue(fontWeight: FontWeight.bold),
            ),
          ),
        ],
      ),
    );
  }
}
