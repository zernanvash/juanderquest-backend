import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';

class ProposalItem {
  final String id;
  final String title;
  final String location;
  final String description;
  final String category;
  final String submittedBy;
  int votes;

  ProposalItem({
    required this.id,
    required this.title,
    required this.location,
    required this.description,
    required this.category,
    required this.submittedBy,
    required this.votes,
  });
}

class VoteScreen extends StatefulWidget {
  final bool showProposalsModal;

  const VoteScreen({super.key, this.showProposalsModal = false});

  @override
  State<VoteScreen> createState() => _VoteScreenState();
}

class _VoteScreenState extends State<VoteScreen> {
  final List<ProposalItem> _proposals = [
    ProposalItem(
      id: 'prop_1',
      title: 'Add Patar White Beach Eco Trail',
      location: 'Bolinao, Pangasinan',
      description: 'Add an eco-quest covering the coastal rock formations, white sand beach trail, and Cape Bolinao lighthouse viewing tower.',
      category: 'ECO-TOURISM',
      submittedBy: 'Juan Dela Cruz',
      votes: 210,
    ),
    ProposalItem(
      id: 'prop_2',
      title: 'Add Tayug Sunflower Maze Quest',
      location: 'Tayug, Pangasinan',
      description: 'Create an interactive agricultural quest at the famous sunflower maze park in eastern Pangasinan.',
      category: 'AGRI-TOURISM',
      submittedBy: 'Maria Santos',
      votes: 142,
    ),
    ProposalItem(
      id: 'prop_3',
      title: 'Add San Fabian Beach Heritage Trail',
      location: 'San Fabian, Pangasinan',
      description: 'Feature WWII historic landing sites along San Fabian beach park.',
      category: 'HERITAGE',
      submittedBy: 'Juan Dela Cruz',
      votes: 98,
    ),
  ];

  final Map<String, bool> _hasVoted = {};

  final _titleController = TextEditingController();
  final _locationController = TextEditingController();
  final _descriptionController = TextEditingController();
  String _selectedCategory = 'ECO-TOURISM';

  @override
  void initState() {
    super.initState();
    if (widget.showProposalsModal) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _showAllProposalsModal(context);
      });
    }
  }

  @override
  void dispose() {
    _titleController.dispose();
    _locationController.dispose();
    _descriptionController.dispose();
    super.dispose();
  }

  void _castVote(String propId) {
    if (_hasVoted[propId] == true) return;
    setState(() {
      final item = _proposals.firstWhere((p) => p.id == propId);
      item.votes += 1;
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

  void _showSubmitLocationModal(BuildContext context) {
    _titleController.clear();
    _locationController.clear();
    _descriptionController.clear();
    _selectedCategory = 'ECO-TOURISM';

    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: const Color(0xFFFAF9F5),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
      builder: (ctx) => Padding(
        padding: EdgeInsets.only(
          bottom: MediaQuery.of(ctx).viewInsets.bottom + 20,
          top: 20,
          left: 20,
          right: 20,
        ),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
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
              Row(
                children: [
                  const Icon(Icons.add_location_alt_rounded, color: Color(0xFF7D5800), size: 24),
                  const SizedBox(width: 8),
                  Text(
                    'Suggest New Location',
                    style: GoogleFonts.epilogue(
                      color: const Color(0xFF582F0E),
                      fontSize: 20,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Text(
                'Submit a new Pangasinan tourist destination spot for community voting.',
                style: GoogleFonts.plusJakartaSans(color: const Color(0xFF514532), fontSize: 13),
              ),
              const SizedBox(height: 20),

              // Title Input
              Text(
                'Destination Spot Title',
                style: GoogleFonts.plusJakartaSans(color: const Color(0xFF582F0E), fontWeight: FontWeight.bold, fontSize: 13),
              ),
              const SizedBox(height: 6),
              TextField(
                controller: _titleController,
                decoration: InputDecoration(
                  hintText: 'e.g. Balingasay River Eco Cruise',
                  filled: true,
                  fillColor: Colors.white,
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: Color(0xFFD5C4AC))),
                  contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                ),
              ),
              const SizedBox(height: 14),

              // Location Input
              Text(
                'Municipality / Location',
                style: GoogleFonts.plusJakartaSans(color: const Color(0xFF582F0E), fontWeight: FontWeight.bold, fontSize: 13),
              ),
              const SizedBox(height: 6),
              TextField(
                controller: _locationController,
                decoration: InputDecoration(
                  hintText: 'e.g. Bolinao, Pangasinan',
                  filled: true,
                  fillColor: Colors.white,
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: Color(0xFFD5C4AC))),
                  contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                ),
              ),
              const SizedBox(height: 14),

              // Category Selector
              Text(
                'Category',
                style: GoogleFonts.plusJakartaSans(color: const Color(0xFF582F0E), fontWeight: FontWeight.bold, fontSize: 13),
              ),
              const SizedBox(height: 6),
              DropdownButtonFormField<String>(
                value: _selectedCategory,
                items: const [
                  DropdownMenuItem(value: 'ECO-TOURISM', child: Text('Eco-Tourism')),
                  DropdownMenuItem(value: 'AGRI-TOURISM', child: Text('Agri-Tourism')),
                  DropdownMenuItem(value: 'HERITAGE', child: Text('Cultural Heritage')),
                  DropdownMenuItem(value: 'FOOD & DINING', child: Text('Food & Culinary')),
                ],
                onChanged: (val) => setState(() => _selectedCategory = val ?? 'ECO-TOURISM'),
                decoration: InputDecoration(
                  filled: true,
                  fillColor: Colors.white,
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: Color(0xFFD5C4AC))),
                  contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                ),
              ),
              const SizedBox(height: 14),

              // Description Input
              Text(
                'Description / Significance',
                style: GoogleFonts.plusJakartaSans(color: const Color(0xFF582F0E), fontWeight: FontWeight.bold, fontSize: 13),
              ),
              const SizedBox(height: 6),
              TextField(
                controller: _descriptionController,
                maxLines: 3,
                decoration: InputDecoration(
                  hintText: 'Describe why this destination should be featured as a quest...',
                  filled: true,
                  fillColor: Colors.white,
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: Color(0xFFD5C4AC))),
                  contentPadding: const EdgeInsets.all(12),
                ),
              ),
              const SizedBox(height: 20),

              // Submit Button
              ElevatedButton.icon(
                onPressed: () {
                  if (_titleController.text.trim().isEmpty || _locationController.text.trim().isEmpty) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('Please fill out the destination title and location.')),
                    );
                    return;
                  }

                  final newProp = ProposalItem(
                    id: 'prop_${DateTime.now().millisecondsSinceEpoch}',
                    title: _titleController.text.trim(),
                    location: _locationController.text.trim(),
                    description: _descriptionController.text.trim().isEmpty
                        ? 'Community suggested Pangasinan destination.'
                        : _descriptionController.text.trim(),
                    category: _selectedCategory,
                    submittedBy: 'Juan Dela Cruz',
                    votes: 1,
                  );

                  setState(() {
                    _proposals.insert(0, newProp);
                    _hasVoted[newProp.id] = true;
                  });

                  Navigator.pop(ctx);

                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                      content: Text(
                        'New location "${newProp.title}" submitted successfully!',
                        style: GoogleFonts.plusJakartaSans(),
                      ),
                      backgroundColor: const Color(0xFF2D6A4F),
                    ),
                  );
                },
                icon: const Icon(Icons.check_circle_rounded),
                label: Text('Submit Location Proposal', style: GoogleFonts.epilogue(fontWeight: FontWeight.bold)),
                style: ElevatedButton.styleFrom(
                  minimumSize: const Size.fromHeight(48),
                  backgroundColor: const Color(0xFFFFB703),
                  foregroundColor: const Color(0xFF6B4B00),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                ),
              ),
            ],
          ),
        ),
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
              ..._proposals.map((prop) => Padding(
                padding: const EdgeInsets.only(bottom: 12.0),
                child: _buildProposalCard(prop),
              )),
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
            icon: const Icon(Icons.add_location_alt_rounded, color: Color(0xFF7D5800)),
            tooltip: 'Suggest Location',
            onPressed: () => _showSubmitLocationModal(context),
          ),
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
                          'COMMUNITY POWERED',
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
                    'Suggest & Vote on Next Spots',
                    style: GoogleFonts.epilogue(
                      color: const Color(0xFF582F0E),
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    'Submit new Pangasinan tourism destinations and participate in community voting to select upcoming quest spots.',
                    style: GoogleFonts.plusJakartaSans(
                      color: const Color(0xFF514532),
                      fontSize: 13,
                      height: 1.4,
                    ),
                  ),
                  const SizedBox(height: 16),
                  ElevatedButton.icon(
                    onPressed: () => _showSubmitLocationModal(context),
                    icon: const Icon(Icons.add_location_alt_rounded, size: 18),
                    label: Text('Suggest New Location', style: GoogleFonts.epilogue(fontWeight: FontWeight.bold)),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFFFFB703),
                      foregroundColor: const Color(0xFF6B4B00),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
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

            ..._proposals.map((prop) => Padding(
              padding: const EdgeInsets.only(bottom: 12.0),
              child: _buildProposalCard(prop),
            )),
          ],
        ),
      ),
    );
  }

  Widget _buildProposalCard(ProposalItem prop) {
    final voted = _hasVoted[prop.id] == true;

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
                  prop.category,
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
                    '${prop.votes} Votes',
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
            prop.title,
            style: GoogleFonts.epilogue(
              color: const Color(0xFF582F0E),
              fontSize: 16,
              fontWeight: FontWeight.bold,
            ),
          ),
          const SizedBox(height: 2),
          Text(
            prop.location,
            style: GoogleFonts.plusJakartaSans(color: const Color(0xFF837560), fontSize: 12),
          ),
          const SizedBox(height: 8),
          Text(
            prop.description,
            style: GoogleFonts.plusJakartaSans(color: const Color(0xFF514532), fontSize: 13, height: 1.4),
          ),
          const SizedBox(height: 14),
          ElevatedButton.icon(
            onPressed: voted ? null : () => _castVote(prop.id),
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
