"""
合规校验模块
确保数据采集行为符合法律法规和平台用户协议
"""
from typing import Callable, Optional


class ComplianceChecker:
    """
    合规检查器
    在采集前、采集中、导出时进行合规校验
    """

    # 禁止采集的字段（隐私信息）
    PRIVATE_FIELDS = {
        "phone", "phone_number", "mobile", "email", "ip", "ip_address",
        "real_name", "id_card", "passport", "address", "location_detail",
        "credit_card", "bank_account", "password",
    }

    # 合规提示文本
    COMPLIANCE_NOTICE = (
        "【合规声明】\n\n"
        "本软件仅供个人学习研究使用，严禁用于任何商业用途。\n\n"
        "使用规则：\n"
        "1. 仅采集社交平台公开可访问的评论、图文内容及用户信息\n"
        "2. 不破解平台限制、不绕过反爬机制用于商业目的\n"
        "3. 不采集手机号、邮箱、IP地址等用户隐私信息\n"
        "4. 采集的数据仅用于个人研究或合法业务线索跟进\n"
        "5. 反爬机制适配仅用于学术研究与个人技术学习\n\n"
        "法律提示：\n"
        "违反平台用户协议、《个人信息保护法》、《网络安全法》进行\n"
        "商业爬取、恶意采集、隐私窃取等行为，将自行承担法律责任。\n\n"
        "点击「同意」即表示您已知晓并承诺遵守上述规定。"
    )

    _callback: Optional[Callable] = None

    @classmethod
    def set_callback(cls, callback: Callable) -> None:
        """设置违规回调（用于界面提示）"""
        cls._callback = callback

    @classmethod
    def check_fields(cls, fields: list) -> tuple[bool, list]:
        """
        检查提取字段是否包含隐私信息
        返回: (是否合规, 违规字段列表)
        """
        lower_fields = {f.lower() for f in fields}
        violations = lower_fields & cls.PRIVATE_FIELDS
        if violations:
            if cls._callback:
                cls._callback(f"检测到违规字段: {', '.join(violations)}，已自动过滤")
            return False, list(violations)
        return True, []

    @classmethod
    def filter_private_fields(cls, data: dict) -> dict:
        """过滤数据中的隐私字段"""
        return {
            k: v for k, v in data.items()
            if k.lower() not in cls.PRIVATE_FIELDS
        }

    @classmethod
    def check_usage_limit(cls, daily_count: int, max_limit: int = 10000) -> bool:
        """
        检查单日使用量是否超限（防止商业规模采集）
        返回: 是否在限制内
        """
        return daily_count < max_limit

    @classmethod
    def get_compliance_notice(cls) -> str:
        """获取合规声明文本"""
        return cls.COMPLIANCE_NOTICE

    @classmethod
    def validate_export_data(cls, data: list) -> list:
        """导出前校验数据：移除可能的隐私字段"""
        cleaned = []
        for record in data:
            cleaned.append(cls.filter_private_fields(record))
        return cleaned
