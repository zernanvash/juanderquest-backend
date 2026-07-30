class SubmissionModel {
  final String id;
  final String questTitle;
  final String category;
  final String status;
  final int rewardPoints;
  final String? rejectionReason;
  final String createdAt;

  SubmissionModel({
    required this.id,
    required this.questTitle,
    required this.category,
    required this.status,
    required this.rewardPoints,
    this.rejectionReason,
    required this.createdAt,
  });

  factory SubmissionModel.fromJson(Map<String, dynamic> json) {
    return SubmissionModel(
      id: json['id'] ?? '',
      questTitle: json['quest_title'] ?? 'Quest',
      category: json['category'] ?? 'eco',
      status: json['status'] ?? 'pending',
      rewardPoints: json['reward_points'] ?? 0,
      rejectionReason: json['rejection_reason'],
      createdAt: json['created_at'] ?? '',
    );
  }
}
