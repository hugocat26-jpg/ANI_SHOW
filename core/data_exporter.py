"""
数据导出模块
支持将线索数据导出为 Excel(.xlsx) 和 CSV 格式
"""
import csv
import os
from datetime import datetime
from pathlib import Path
from typing import Optional

import pandas as pd

from storage.database import Database
from config.settings import get_settings
from utils.logger import Logger
from utils.compliance import ComplianceChecker


class DataExporter:
    """数据导出器"""

    FIELD_NAME_MAP = {
        "user_id": "用户ID",
        "nickname": "昵称",
        "gender": "性别",
        "comment_text": "意向评论",
        "comment_time": "评论时间",
        "intent_level": "意向等级",
        "intent_keywords": "匹配关键词",
        "llm_verified": "大模型校验",
        "llm_analysis": "大模型分析",
        "platform": "平台",
        "platform_name": "平台",
        "source_url": "来源链接",
        "likes": "点赞数",
        "collected_at": "采集时间",
        "notes": "备注",
    }

    def __init__(self, database: Optional[Database] = None):
        self.database = database or Database()
        self.logger = Logger()

    def export(
        self,
        file_path: str,
        format_type: str = "xlsx",
        fields: Optional[list] = None,
        intent_level: Optional[str] = None,
        platform: Optional[str] = None,
        keyword: Optional[str] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
    ) -> tuple[bool, str]:
        """
        导出线索数据到文件
        参数:
            file_path: 输出文件路径
            format_type: 导出格式 (xlsx/csv)
            fields: 导出字段列表
            intent_level: 筛选意向等级
            platform: 筛选平台
            keyword: 搜索关键词
            date_from / date_to: 时间范围
        返回:
            (是否成功, 消息)
        """
        try:
            # 查询数据
            leads = self.database.get_leads(
                intent_level=intent_level,
                platform=platform,
                keyword=keyword,
                date_from=date_from,
                date_to=date_to,
                limit=100000,
                order_by="collected_at DESC",
            )

            if not leads:
                return False, "没有符合条件的数据可导出"

            # 使用导出列名
            export_fields = self._normalize_export_fields(
                fields or get_settings().config.export.default_fields
            )
            export_df = pd.DataFrame([lead.to_export_dict(export_fields) for lead in leads])

            # 合规校验：过滤隐私字段
            records = export_df.to_dict(orient="records")
            cleaned_records = ComplianceChecker.validate_export_data(records)
            export_df = pd.DataFrame(cleaned_records)
            for column in export_df.columns:
                export_df[column] = export_df[column].apply(self._neutralize_spreadsheet_formula)

            # 导出
            if format_type == "csv":
                export_df.to_csv(file_path, index=False, encoding="utf-8-sig")
            else:  # xlsx
                with pd.ExcelWriter(file_path, engine="openpyxl") as writer:
                    export_df.to_excel(writer, sheet_name="客户线索", index=False)
                    # 自动调整列宽
                    worksheet = writer.sheets["客户线索"]
                    for col in worksheet.columns:
                        max_length = 0
                        col_letter = col[0].column_letter
                        for cell in col:
                            try:
                                max_length = max(max_length, len(str(cell.value or "")))
                            except Exception:
                                pass
                        worksheet.column_dimensions[col_letter].width = min(max_length + 2, 50)

            self.logger.success(f"导出成功: {file_path} ({len(leads)}条记录)")
            return True, f"导出成功! 共{len(leads)}条线索，保存至:\n{file_path}"

        except PermissionError:
            return False, "文件被占用或没有写入权限，请关闭文件后重试"
        except Exception as e:
            self.logger.error(f"导出失败: {str(e)}")
            return False, f"导出失败: {str(e)}"

    @staticmethod
    def generate_default_filename(format_type: str = "xlsx") -> str:
        """生成默认文件名: 客户线索_20250101_143000.xlsx"""
        now = datetime.now()
        timestamp = now.strftime("%Y%m%d_%H%M%S")
        return f"客户线索_{timestamp}.{format_type}"

    @staticmethod
    def get_save_path(directory: str, filename: str) -> str:
        """获取完整保存路径，避免重名"""
        file_path = os.path.join(directory, filename)
        base, ext = os.path.splitext(filename)
        counter = 1
        while os.path.exists(file_path):
            file_path = os.path.join(directory, f"{base}({counter}){ext}")
            counter += 1
        return file_path

    @classmethod
    def _normalize_export_fields(cls, fields: Optional[list]) -> Optional[list]:
        """兼容配置中的内部字段名和界面中的中文列名。"""
        if not fields:
            return None
        return [cls.FIELD_NAME_MAP.get(field, field) for field in fields]

    @staticmethod
    def _neutralize_spreadsheet_formula(value):
        """防止 CSV/XLSX 被表格软件按公式执行。"""
        if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r"):
            return f"'{value}"
        return value
