import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../auth/providers/auth_provider.dart';

class ProfileScreen extends ConsumerWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(authProvider).user;

    return Scaffold(
      backgroundColor: const Color(0xFF0A0F1D),
      appBar: AppBar(
        backgroundColor: const Color(0xFF131B2E),
        elevation: 0,
        title: const Text('Traveler Profile', style: TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.bold)),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20.0),
        child: Column(
          children: [
            Center(
              child: Column(
                children: [
                  CircleAvatar(
                    radius: 40,
                    backgroundColor: const Color(0xFF00F2FE),
                    child: Text(
                      user?.displayName.substring(0, 1) ?? 'J',
                      style: const TextStyle(fontSize: 32, fontWeight: FontWeight.bold, color: Color(0xFF0A0F1D)),
                    ),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    user?.displayName ?? 'Juan Dela Cruz',
                    style: const TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.bold),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    user?.email ?? 'juan@juanderquest.ph',
                    style: const TextStyle(color: Color(0xFF94A3B8), fontSize: 13),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 28),

            // Demo Points Counter Card
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                gradient: const LinearGradient(
                  colors: [Color(0xFF131B2E), Color(0xFF1C273E)],
                ),
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: const Color(0xFFFFB703).withOpacity(0.4)),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Off-Chain Demo Points', style: TextStyle(color: Color(0xFF94A3B8), fontSize: 12)),
                      SizedBox(height: 4),
                      Text('JuanderQuest Balance', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 15)),
                    ],
                  ),
                  Row(
                    children: [
                      const Icon(Icons.stars_rounded, color: Color(0xFFFFB703), size: 28),
                      const SizedBox(width: 8),
                      Text(
                        '${user?.demoPoints ?? 0}',
                        style: const TextStyle(color: Color(0xFFFFB703), fontSize: 26, fontWeight: FontWeight.bold),
                      ),
                    ],
                  ),
                ],
              ),
            ),

            const SizedBox(height: 24),
            // NFT Badges Placeholder Card
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: const Color(0xFF131B2E),
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: Colors.white.withOpacity(0.08)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      const Text('Soulbound NFT Badges', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 16)),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                        decoration: BoxDecoration(
                          color: Colors.white.withOpacity(0.1),
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: const Text('DEFERRED FOR PROTOTYPE', style: TextStyle(color: Color(0xFF94A3B8), fontSize: 9, fontWeight: FontWeight.bold)),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceAround,
                    children: [
                      _buildBadgePlaceholder(Icons.eco_rounded, 'Eco Pioneer'),
                      _buildBadgePlaceholder(Icons.museum_rounded, 'Heritage Keeper'),
                      _buildBadgePlaceholder(Icons.restaurant_rounded, 'Bangus Gourmet'),
                    ],
                  ),
                ],
              ),
            ),

            const SizedBox(height: 32),
            ElevatedButton.icon(
              onPressed: () {
                ref.read(authProvider.notifier).logout();
                context.go('/');
              },
              icon: const Icon(Icons.logout_rounded),
              label: const Text('Logout'),
              style: ElevatedButton.styleFrom(
                minimumSize: const Size.fromHeight(50),
                backgroundColor: const Color(0xFFF43F5E).withOpacity(0.15),
                foregroundColor: const Color(0xFFF43F5E),
                elevation: 0,
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
              ),
            ),
          ],
        ),
      ),
      bottomNavigationBar: BottomNavigationBar(
        backgroundColor: const Color(0xFF131B2E),
        selectedItemColor: const Color(0xFF00F2FE),
        unselectedItemColor: const Color(0xFF64748B),
        currentIndex: 2,
        onTap: (index) {
          if (index == 0) context.go('/quests');
          if (index == 1) context.go('/history');
        },
        items: const [
          BottomNavigationBarItem(icon: Icon(Icons.map), label: 'Quests'),
          BottomNavigationBarItem(icon: Icon(Icons.history), label: 'Submissions'),
          BottomNavigationBarItem(icon: Icon(Icons.person), label: 'Profile'),
        ],
      ),
    );
  }

  Widget _buildBadgePlaceholder(IconData icon, String label) {
    return Column(
      children: [
        Container(
          width: 56,
          height: 56,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: const Color(0xFF1C273E),
            border: Border.all(color: Colors.white24),
          ),
          child: Icon(icon, color: const Color(0xFF94A3B8), size: 28),
        ),
        const SizedBox(height: 6),
        Text(label, style: const TextStyle(color: Color(0xFF94A3B8), fontSize: 11)),
      ],
    );
  }
}
