import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../auth/providers/auth_provider.dart';
import '../providers/quest_provider.dart';
import '../models/quest_model.dart';

class QuestListScreen extends ConsumerStatefulWidget {
  const QuestListScreen({super.key});

  @override
  ConsumerState<QuestListScreen> createState() => _QuestListScreenState();
}

class _QuestListScreenState extends ConsumerState<QuestListScreen> {
  String? _selectedCategory;

  @override
  void initState() {
    super.initState();
    Future.microtask(() {
      ref.read(questProvider.notifier).fetchQuests();
    });
  }

  @override
  Widget build(BuildContext context) {
    final questState = ref.watch(questProvider);
    final user = ref.watch(authProvider).user;

    return Scaffold(
      backgroundColor: const Color(0xFF0A0F1D),
      appBar: AppBar(
        backgroundColor: const Color(0xFF131B2E),
        elevation: 0,
        title: Row(
          children: [
            Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: const Color(0xFF00F2FE).withOpacity(0.15),
                borderRadius: BorderRadius.circular(10),
              ),
              child: const Icon(Icons.explore, color: Color(0xFF00F2FE), size: 20),
            ),
            const SizedBox(width: 12),
            const Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Pangasinan Quests', style: TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.bold)),
                Text('Discover & Earn Points', style: TextStyle(color: Color(0xFF94A3B8), fontSize: 11)),
              ],
            ),
          ],
        ),
        actions: [
          Container(
            margin: const EdgeInsets.only(right: 16),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            decoration: BoxDecoration(
              color: const Color(0xFF1C273E),
              borderRadius: BorderRadius.circular(20),
              border: Border.all(color: const Color(0xFFFFB703).withOpacity(0.4)),
            ),
            child: Row(
              children: [
                const Icon(Icons.stars, color: Color(0xFFFFB703), size: 16),
                const SizedBox(width: 6),
                Text(
                  '${user?.demoPoints ?? 0} pts',
                  style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 13),
                ),
              ],
            ),
          ),
        ],
      ),
      body: Column(
        children: [
          // Filter Chips
          Container(
            height: 54,
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 16),
              children: [
                _buildFilterChip('All', null),
                _buildFilterChip('Eco', 'eco'),
                _buildFilterChip('Cultural', 'cultural'),
                _buildFilterChip('Food & Trade', 'food_trade'),
              ],
            ),
          ),

          // Quest Feed List
          Expanded(
            child: questState.isLoading
                ? const Center(child: CircularProgressIndicator(color: Color(0xFF00F2FE)))
                : questState.quests.isEmpty
                    ? const Center(child: Text('No quests found', style: TextStyle(color: Color(0xFF94A3B8))))
                    : ListView.builder(
                        padding: const EdgeInsets.all(16),
                        itemCount: questState.quests.length,
                        itemBuilder: (context, index) {
                          final quest = questState.quests[index];
                          return _buildQuestCard(context, quest);
                        },
                      ),
          ),
        ],
      ),
      bottomNavigationBar: BottomNavigationBar(
        backgroundColor: const Color(0xFF131B2E),
        selectedItemColor: const Color(0xFF00F2FE),
        unselectedItemColor: const Color(0xFF64748B),
        currentIndex: 0,
        onTap: (index) {
          if (index == 1) context.go('/history');
          if (index == 2) context.go('/profile');
        },
        items: const [
          BottomNavigationBarItem(icon: Icon(Icons.map), label: 'Quests'),
          BottomNavigationBarItem(icon: Icon(Icons.history), label: 'Submissions'),
          BottomNavigationBarItem(icon: Icon(Icons.person), label: 'Profile'),
        ],
      ),
    );
  }

  Widget _buildFilterChip(String label, String? category) {
    final isSelected = _selectedCategory == category;
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: FilterChip(
        label: Text(label),
        selected: isSelected,
        selectedColor: const Color(0xFF00F2FE),
        backgroundColor: const Color(0xFF1C273E),
        labelStyle: TextStyle(
          color: isSelected ? const Color(0xFF0A0F1D) : Colors.white,
          fontWeight: isSelected ? FontWeight.bold : FontWeight.normal,
        ),
        onSelected: (selected) {
          setState(() {
            _selectedCategory = selected ? category : null;
          });
          ref.read(questProvider.notifier).fetchQuests(category: _selectedCategory);
        },
      ),
    );
  }

  Widget _buildQuestCard(BuildContext context, QuestModel quest) {
    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      decoration: BoxDecoration(
        color: const Color(0xFF1C273E),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: Colors.white.withOpacity(0.08)),
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: () => context.push('/quests/${quest.id}', extra: quest),
          child: Padding(
            padding: const EdgeInsets.all(16.0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                      decoration: BoxDecoration(
                        color: const Color(0xFF00F2FE).withOpacity(0.15),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(
                        quest.category.toUpperCase(),
                        style: const TextStyle(
                          color: Color(0xFF00F2FE),
                          fontSize: 10,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ),
                    Row(
                      children: [
                        const Icon(Icons.stars_rounded, color: Color(0xFFFFB703), size: 16),
                        const SizedBox(width: 4),
                        Text(
                          '+${quest.rewardPoints} pts',
                          style: const TextStyle(color: Color(0xFFFFB703), fontWeight: FontWeight.bold, fontSize: 13),
                        ),
                      ],
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Text(
                  quest.title,
                  style: const TextStyle(color: Colors.white, fontSize: 17, fontWeight: FontWeight.bold),
                ),
                const SizedBox(height: 6),
                Row(
                  children: [
                    const Icon(Icons.location_on, color: Color(0xFF94A3B8), size: 14),
                    const SizedBox(width: 4),
                    Text(quest.locationName, style: const TextStyle(color: Color(0xFF94A3B8), fontSize: 12)),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
