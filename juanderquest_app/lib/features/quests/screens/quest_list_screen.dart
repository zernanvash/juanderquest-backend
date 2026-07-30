import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
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
  final TextEditingController _searchController = TextEditingController();

  @override
  void initState() {
    super.initState();
    Future.microtask(() {
      ref.read(questProvider.notifier).fetchQuests();
    });
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final questState = ref.watch(questProvider);
    final user = ref.watch(authProvider).user;

    return Scaffold(
      backgroundColor: const Color(0xFFFAF9F5),
      appBar: AppBar(
        backgroundColor: const Color(0xFFFAF9F5),
        elevation: 0,
        scrolledUnderElevation: 0,
        title: Row(
          children: [
            const Icon(Icons.explore, color: Color(0xFF7D5800), size: 24),
            const SizedBox(width: 8),
            Text(
              'JuanderQuest',
              style: GoogleFonts.epilogue(
                color: const Color(0xFF7D5800),
                fontSize: 20,
                fontWeight: FontWeight.bold,
              ),
            ),
          ],
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.history_rounded, color: Color(0xFF7D5800)),
            tooltip: 'Submissions History',
            onPressed: () => context.push('/history'),
          ),
          Container(
            margin: const EdgeInsets.only(right: 16),
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
            decoration: BoxDecoration(
              color: const Color(0xFFEFEEEA),
              borderRadius: BorderRadius.circular(20),
              border: Border.all(color: const Color(0xFFD5C4AC).withValues(alpha: 0.5)),
            ),
            child: Row(
              children: [
                Image.asset(
                  'assets/images/jdq-token.png',
                  width: 20,
                  height: 20,
                  errorBuilder: (_, __, ___) => const Icon(Icons.stars, color: Color(0xFFFFB703), size: 18),
                ),
                const SizedBox(width: 6),
                Text(
                  '${user?.demoPoints ?? 0} PTS',
                  style: GoogleFonts.plusJakartaSans(
                    color: const Color(0xFF6B4B00),
                    fontWeight: FontWeight.bold,
                    fontSize: 12,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(20.0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // Greeting Section
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            'Hello, Explorer!',
                            style: GoogleFonts.plusJakartaSans(
                              color: const Color(0xFF514532),
                              fontSize: 14,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            user?.displayName ?? 'Juan Dela Cruz',
                            style: GoogleFonts.epilogue(
                              color: const Color(0xFF582F0E),
                              fontSize: 22,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                        ],
                      ),
                      Container(
                        width: 50,
                        height: 50,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          border: Border.all(color: const Color(0xFFFFB703), width: 2),
                          image: DecorationImage(
                            image: NetworkImage(
                              user?.avatarUrl.isNotEmpty == true
                                  ? user!.avatarUrl
                                  : 'https://api.dicebear.com/7.x/avataaars/svg?seed=Juan',
                            ),
                            fit: BoxFit.cover,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 20),

                  // Search Bar
                  TextField(
                    controller: _searchController,
                    decoration: InputDecoration(
                      hintText: 'Search quests in Pangasinan...',
                      hintStyle: GoogleFonts.plusJakartaSans(color: const Color(0xFF837560), fontSize: 14),
                      prefixIcon: const Icon(Icons.search, color: Color(0xFF837560)),
                      filled: true,
                      fillColor: Colors.white,
                      contentPadding: const EdgeInsets.symmetric(vertical: 12),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(14),
                        borderSide: BorderSide(color: const Color(0xFFD5C4AC).withValues(alpha: 0.4)),
                      ),
                      enabledBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(14),
                        borderSide: BorderSide(color: const Color(0xFFD5C4AC).withValues(alpha: 0.4)),
                      ),
                    ),
                  ),
                  const SizedBox(height: 16),

                  // Category Filter Chips
                  SizedBox(
                    height: 40,
                    child: ListView(
                      scrollDirection: Axis.horizontal,
                      children: [
                        _buildCategoryChip('All Quests', null, Icons.apps),
                        _buildCategoryChip('Eco', 'eco', Icons.eco),
                        _buildCategoryChip('Cultural', 'cultural', Icons.museum),
                        _buildCategoryChip('Food & Trade', 'food_trade', Icons.restaurant),
                      ],
                    ),
                  ),
                  const SizedBox(height: 24),

                  // Featured Discovery Hero Card
                  Text(
                    'Featured Discovery',
                    style: GoogleFonts.epilogue(
                      color: const Color(0xFF1B1C1A),
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  const SizedBox(height: 12),
                  _buildFeaturedQuestCard(context),
                  const SizedBox(height: 24),

                  // Nearby Adventures List Header
                  Text(
                    'Nearby Adventures',
                    style: GoogleFonts.epilogue(
                      color: const Color(0xFF1B1C1A),
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  const SizedBox(height: 12),

                  // Quests List Feed
                  if (questState.isLoading)
                    const Center(
                      child: Padding(
                        padding: EdgeInsets.all(32.0),
                        child: CircularProgressIndicator(color: Color(0xFFFFB703)),
                      ),
                    )
                  else if (questState.quests.isEmpty)
                    Container(
                      padding: const EdgeInsets.all(32),
                      child: Center(
                        child: Text(
                          'No quests found in this category.',
                          textAlign: TextAlign.center,
                          style: GoogleFonts.plusJakartaSans(color: const Color(0xFF837560)),
                        ),
                      ),
                    )
                  else
                    ListView.builder(
                      shrinkWrap: true,
                      physics: const NeverScrollableScrollPhysics(),
                      itemCount: questState.quests.length,
                      itemBuilder: (context, index) {
                        final quest = questState.quests[index];
                        return _buildQuestItemCard(context, quest);
                      },
                    ),
                ],
              ),
            ),
          ),
        ],
      ),

    );
  }

  Widget _buildCategoryChip(String label, String? category, IconData icon) {
    final isSelected = _selectedCategory == category;

    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: ChoiceChip(
        avatar: Icon(
          icon,
          size: 16,
          color: isSelected ? const Color(0xFF6B4B00) : const Color(0xFF514532),
        ),
        label: Text(label),
        selected: isSelected,
        selectedColor: const Color(0xFFFFB703),
        backgroundColor: const Color(0xFFE9E8E4),
        labelStyle: GoogleFonts.plusJakartaSans(
          color: isSelected ? const Color(0xFF6B4B00) : const Color(0xFF514532),
          fontWeight: isSelected ? FontWeight.bold : FontWeight.w600,
          fontSize: 12,
        ),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        onSelected: (selected) {
          setState(() {
            _selectedCategory = selected ? category : null;
          });
          ref.read(questProvider.notifier).fetchQuests(category: _selectedCategory);
        },
      ),
    );
  }

  Widget _buildFeaturedQuestCard(BuildContext context) {
    final featuredQuest = QuestModel(
      id: 'q1111111-1111-1111-1111-111111111111',
      title: 'Hundred Islands Eco Trek',
      description: "Visit Governor's Island viewing deck in Alaminos City and scan the eco-marker.",
      category: 'eco',
      locationName: 'Alaminos City, Pangasinan',
      gpsLat: 16.2063,
      gpsLng: 119.9706,
      radiusMeters: 150,
      rewardPoints: 50,
      markerCode: 'MARKER_HUNDRED_ISLANDS_01',
      markerImageUrl: 'https://raw.githubusercontent.com/JuanderQuest/assets/main/markers/hundred_islands.png',
    );

    return GestureDetector(
      onTap: () => context.push('/quests/${featuredQuest.id}', extra: featuredQuest),
      child: Container(
        height: 200,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(16),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.1),
              blurRadius: 10,
              offset: const Offset(0, 4),
            ),
          ],
          image: const DecorationImage(
            image: AssetImage('assets/images/pangasinan_banner.png'),
            fit: BoxFit.cover,
          ),
        ),
        child: Stack(
          children: [
            Container(
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(16),
                gradient: LinearGradient(
                  colors: [
                    Colors.black.withValues(alpha: 0.8),
                    Colors.transparent,
                  ],
                  begin: Alignment.bottomCenter,
                  end: Alignment.topCenter,
                ),
              ),
            ),
            Positioned(
              top: 12,
              left: 12,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: const Color(0xFF2D6A4F),
                  borderRadius: BorderRadius.circular(4),
                ),
                child: Text(
                  'FEATURED EVENT',
                  style: GoogleFonts.plusJakartaSans(
                    color: Colors.white,
                    fontSize: 10,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
            ),
            Positioned(
              bottom: 16,
              left: 16,
              right: 16,
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          featuredQuest.title,
                          style: GoogleFonts.epilogue(
                            color: Colors.white,
                            fontSize: 18,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                        Row(
                          children: [
                            const Icon(Icons.location_on, color: Colors.white70, size: 14),
                            const SizedBox(width: 4),
                            Text(
                              featuredQuest.locationName,
                              style: GoogleFonts.plusJakartaSans(
                                color: Colors.white70,
                                fontSize: 12,
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                    decoration: BoxDecoration(
                      color: const Color(0xFFFFB703),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Column(
                      children: [
                        Text(
                          '+${featuredQuest.rewardPoints}',
                          style: GoogleFonts.epilogue(
                            color: const Color(0xFF6B4B00),
                            fontWeight: FontWeight.bold,
                            fontSize: 16,
                          ),
                        ),
                        Text(
                          'PTS',
                          style: GoogleFonts.plusJakartaSans(
                            color: const Color(0xFF6B4B00),
                            fontWeight: FontWeight.bold,
                            fontSize: 9,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildQuestItemCard(BuildContext context, QuestModel quest) {
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFD5C4AC).withValues(alpha: 0.3)),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.02),
            blurRadius: 6,
            offset: const Offset(0, 2),
          ),
        ],
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: () => context.push('/quests/${quest.id}', extra: quest),
          child: Padding(
            padding: const EdgeInsets.all(14.0),
            child: Row(
              children: [
                Container(
                  width: 60,
                  height: 60,
                  decoration: BoxDecoration(
                    color: const Color(0xFFBEEAD1),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: const Icon(Icons.place_rounded, color: Color(0xFF3F6653), size: 30),
                ),
                const SizedBox(width: 14),

                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Flexible(
                            child: Text(
                              quest.title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: GoogleFonts.epilogue(
                                color: const Color(0xFF582F0E),
                                fontSize: 15,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ),
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                            decoration: BoxDecoration(
                              color: const Color(0xFF3F6653).withValues(alpha: 0.1),
                              borderRadius: BorderRadius.circular(6),
                            ),
                            child: Text(
                              quest.category.toUpperCase(),
                              style: GoogleFonts.plusJakartaSans(
                                color: const Color(0xFF3F6653),
                                fontSize: 9,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 4),
                      Row(
                        children: [
                          const Icon(Icons.location_on_outlined, color: Color(0xFF837560), size: 14),
                          const SizedBox(width: 4),
                          Text(
                            quest.locationName,
                            style: GoogleFonts.plusJakartaSans(
                              color: const Color(0xFF837560),
                              fontSize: 12,
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 6),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
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
                                '${quest.rewardPoints} PTS',
                                style: GoogleFonts.plusJakartaSans(
                                  color: const Color(0xFF7D5800),
                                  fontWeight: FontWeight.bold,
                                  fontSize: 12,
                                ),
                              ),
                            ],
                          ),
                          Text(
                            'AVAILABLE',
                            style: GoogleFonts.plusJakartaSans(
                              color: const Color(0xFF2D6A4F),
                              fontWeight: FontWeight.bold,
                              fontSize: 10,
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
