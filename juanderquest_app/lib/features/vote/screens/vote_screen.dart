import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';

class VoteScreen extends StatefulWidget {
  final bool showProposalsModal;

  const VoteScreen({super.key, this.showProposalsModal = false});

  @override
  State<VoteScreen> createState() => _VoteScreenState();
}

class _VoteScreenState extends State<VoteScreen> {
  final Map<String, int> _votes = {
    'prop_1': 142,
    'prop_2': 98,
    'prop_3': 210,
  };

  final Map<String, bool> _hasVoted = {};

  @override
  void initState() {
    super.initState();
    if (widget.showProposalsModal) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _showAllProposalsModal(context);
      });
    }
  }

  void _castVote(String propId) {
    if (_hasVoted[propId] == true) return;
    setState(() {
      _votes[propId] = (_votes[propId] ?? 0) + 1;
      _hasVoted[propId] = true;
    });

    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          'Vote cast successfully! Thank you for participating in Tourism Spot Voting.',
          style: GoogleFonts.plusJakartaSans(),
        ),
        backgroundColor: const Color(0xFF2D6A4F),
      ),
    );
  }

  void _showAllProposalsModal(BuildContext context) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: const Color(0xFFFAF9F5),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (ctx) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.75,
        maxChildSize: 0.9,
        builder: (_, scrollController) => Padding(
          padding: const EdgeInsets.all(20.0),
          child: ListView(
            controller: scrollController,
            children: [
              Center(
                child: Container(
                  width: 40,
                  height: 4,
                  decoration: BoxDecoration(
                    color: const Color(0xFFD5C4AC),
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
              ),
              const SizedBox(height: 16),
              Text(
                'All Proposed Tourism Destinations',
                style: GoogleFonts.epilogue(
                  color: const Color(0xFF582F0E),
                  fontSize: 20,
                  fontWeight: FontWeight.bold,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                'Explore full detailed guidelines for community-suggested Pangasinan quest spots.',
                style: GoogleFonts.plusJakartaSans(color: const Color(0xFF514532), fontSize: 13),
              ),
              const SizedBox(height: 20),
              _buildProposalCard(
                id: 'prop_3',
                title: 'Add Patar White Beach Eco Trail',
                location: 'Bolinao, Pangasinan',
                description: 'Add an eco-quest covering the coastal rock formations, white sand beach trail, and Cape Bolinao lighthouse viewing tower.',
                category: 'ECO-TOURISM',
              ),
              const SizedBox(height: 12),
              _buildProposalCard(
                id: 'prop_1',
                title: 'Add Tayug Sunflower Maze Quest',
                location: 'Tayug, Pangasinan',
                description: 'Create an interactive agricultural quest at the famous sunflower maze park in eastern Pangasinan.',
                category: 'AGRI-TOURISM',
              ),
              const SizedBox(height: 12),
              _buildProposalCard(
                id: 'prop_2',
                title: 'Add San Fabian Beach Heritage Trail',
                location: 'San Fabian, Pangasinan',
                description: 'Feature WWII historic landing sites along San Fabian beach.',
                category: 'HERITAGE',
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFFAF9F5),
      appBar: AppBar(
        backgroundColor: const Color(0xFFFAF9F5),
        elevation: 0,
        scrolledUnderElevation: 0,
        title: Text(
          'Tourism Spot Voting',
          style: GoogleFonts.epilogue(
            color: const Color(0xFF582F0E),
            fontSize: 20,
            fontWeight: FontWeight.bold,
          ),
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.list_alt_rounded, color: Color(0xFF582F0E)),
            tooltip: 'View All Proposals',
            onPressed: () => context.push('/vote/proposals'),
          ),
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(20.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Header Card
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
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(
                        'TOURISM SPOT VOTING',
                        style: GoogleFonts.plusJakartaSans(
                          color: const Color(0xFF7D5800),
                          fontSize: 11,
                          fontWeight: FontWeight.bold,
                          letterSpacing: 1.0,
                        ),
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                        decoration: BoxDecoration(
                          color: const Color(0xFF3F6653).withValues(alpha: 0.15),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Text(
                          'ACTIVE VOTES',
                          style: GoogleFonts.plusJakartaSans(
                            color: const Color(0xFF3F6653),
                            fontSize: 10,
                            fontWeight: FontWeight.bold,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Vote on Next Pangasinan Quests',
                    style: GoogleFonts.epilogue(
                      color: const Color(0xFF582F0E),
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    'Participate in community voting to select which historic, eco, and food spots in Pangasinan should be featured in upcoming quest updates.',
                    style: GoogleFonts.plusJakartaSans(
                      color: const Color(0xFF514532),
                      fontSize: 13,
                      height: 1.4,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 24),

            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  'Community Proposals',
                  style: GoogleFonts.epilogue(
                    color: const Color(0xFF0D1B2A),
                    fontSize: 18,
                    fontWeight: FontWeight.bold,
                  ),
                ),
                TextButton.icon(
                  onPressed: () => context.push('/vote/proposals'),
                  icon: const Icon(Icons.open_in_new, size: 16, color: Color(0xFF7D5800)),
                  label: Text(
                    'View All',
                    style: GoogleFonts.plusJakartaSans(
                      color: const Color(0xFF7D5800),
                      fontWeight: FontWeight.bold,
                      fontSize: 12,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),

            _buildProposalCard(
              id: 'prop_3',
              title: 'Add Patar White Beach Eco Trail',
              location: 'Bolinao, Pangasinan',
              description: 'Add an eco-quest covering the coastal rock formations and white sand beach trail in Bolinao.',
              category: 'ECO-TOURISM',
            ),
            const SizedBox(height: 12),
            _buildProposalCard(
              id: 'prop_1',
              title: 'Add Tayug Sunflower Maze Quest',
              location: 'Tayug, Pangasinan',
              description: 'Create an interactive agricultural quest at the famous sunflower maze park in eastern Pangasinan.',
              category: 'AGRI-TOURISM',
            ),
            const SizedBox(height: 12),
            _buildProposalCard(
              id: 'prop_2',
              title: 'Add San Fabian Beach Heritage Trail',
              location: 'San Fabian, Pangasinan',
              description: 'Feature WWII historic landing sites along San Fabian beach.',
              category: 'HERITAGE',
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
          currentIndex: 2,
          type: BottomNavigationBarType.fixed,
          elevation: 0,
          onTap: (index) {
            if (index == 0) context.go('/quests');
            if (index == 1) context.go('/map');
            if (index == 3) context.go('/shop');
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

  Widget _buildProposalCard({
    required String id,
    required String title,
    required String location,
    required String description,
    required String category,
  }) {
    final votesCount = _votes[id] ?? 0;
    final voted = _hasVoted[id] == true;

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
                  color: const Color(0xFFEFEEEA),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  category,
                  style: GoogleFonts.plusJakartaSans(
                    color: const Color(0xFF837560),
                    fontSize: 9,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
              Row(
                children: [
                  const Icon(Icons.how_to_vote_rounded, color: Color(0xFF7D5800), size: 16),
                  const SizedBox(width: 4),
                  Text(
                    '$votesCount Votes',
                    style: GoogleFonts.plusJakartaSans(
                      color: const Color(0xFF7D5800),
                      fontWeight: FontWeight.bold,
                      fontSize: 12,
                    ),
                  ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            title,
            style: GoogleFonts.epilogue(
              color: const Color(0xFF582F0E),
              fontSize: 16,
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            location,
            style: GoogleFonts.plusJakartaSans(color: const Color(0xFF837560), fontSize: 12),
          ),
          const SizedBox(height: 8),
          Text(
            description,
            style: GoogleFonts.plusJakartaSans(color: const Color(0xFF514532), fontSize: 13, height: 1.4),
          ),
          const SizedBox(height: 14),
          ElevatedButton.icon(
            onPressed: voted ? null : () => _castVote(id),
            icon: Icon(voted ? Icons.check : Icons.thumb_up_alt_outlined),
            label: Text(
              voted ? 'Vote Cast' : 'Vote for Spot',
              style: GoogleFonts.epilogue(fontWeight: FontWeight.bold),
            ),
            style: ElevatedButton.styleFrom(
              minimumSize: const Size.fromHeight(42),
              backgroundColor: voted ? const Color(0xFF3F6653) : const Color(0xFFFFB703),
              foregroundColor: voted ? Colors.white : const Color(0xFF6B4B00),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            ),
          ),
        ],
      ),
    );
  }
}
