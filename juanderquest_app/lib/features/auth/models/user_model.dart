class UserModel {
  final String id;
  final String seedId;
  final String displayName;
  final String email;
  final String avatarUrl;
  final String role;
  final int demoPoints;

  UserModel({
    required this.id,
    required this.seedId,
    required this.displayName,
    required this.email,
    required this.avatarUrl,
    required this.role,
    required this.demoPoints,
  });

  factory UserModel.fromJson(Map<String, dynamic> json) {
    return UserModel(
      id: json['id'] ?? '',
      seedId: json['seed_id'] ?? '',
      displayName: json['display_name'] ?? 'Traveler',
      email: json['email'] ?? '',
      avatarUrl: json['avatar_url'] ?? '',
      role: json['role'] ?? 'user',
      demoPoints: json['demo_points'] ?? 0,
    );
  }

  UserModel copyWith({int? demoPoints}) {
    return UserModel(
      id: id,
      seedId: seedId,
      displayName: displayName,
      email: email,
      avatarUrl: avatarUrl,
      role: role,
      demoPoints: demoPoints ?? this.demoPoints,
    );
  }
}
