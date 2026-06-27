# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-06-27

### Added
- 初始版本
- 本地 skill 原件库扫描（official / github / personal / archived 四个来源）
- 按项目软链接启用 skill 到 `.agents/skills/<alias>`
- 可选同步 Claude Code 入口（创建 `.claude/skills` 指向 `.agents/skills`）
- 一键启用 / 禁用 agents skills
- 一键加入 / 清理 Claude Code skills
- 单个 Claude skill 读取、禁用
- Web UI（`public/`）展示原件库、已启用列表、Claude skill 状态
- 基础测试覆盖（`node --test test/*.test.js`）