# AWS to Open-Source Migration

This directory contains documentation from the complete migration of AR.IO Bundler from AWS-based infrastructure to open-source alternatives.

## Migration Summary

**Completion Date**: October 24, 2025

The AR.IO Bundler was successfully migrated from a cloud-dependent AWS architecture to a fully open-source, self-hosted infrastructure stack.

### What Changed

| AWS Service | Replaced With | Status |
|-------------|---------------|--------|
| AWS Secrets Manager | Environment variables (.env) | ✅ Complete |
| AWS Systems Manager (SSM) | Environment variables (.env) | ✅ Complete |
| Amazon S3 | MinIO (S3-compatible) | ✅ Complete |
| Amazon DynamoDB | PostgreSQL 16 | ✅ Complete |
| Amazon SQS | BullMQ (Redis-based) | ✅ Complete |
| AWS Lambda | PM2 Worker Processes | ✅ Complete |
| Amazon ECS | PM2 Process Manager | ✅ Complete |
| Amazon ElastiCache | Redis 7.2 | ✅ Complete |

### Migration Benefits

- **Cost Reduction**: Eliminated AWS service charges
- **Data Control**: Full ownership of infrastructure and data
- **Portability**: Can deploy anywhere (local, VPS, bare metal)
- **Simplicity**: Fewer external dependencies and integrations
- **Performance**: PostgreSQL batch operations 20x larger than DynamoDB
- **Debugging**: Direct access to all logs, databases, and queues

### Test Results

- **Unit Tests**: 326/326 passing (100%)
  - Payment Service: 143/143 ✅
  - Upload Service: 183/183 ✅
- **Integration Tests**: Environmental setup (not AWS-related)
- **Functionality**: All features working as expected

## Migration Documents

This directory contains the following historical documents from the migration process:

### Planning Documents

- **AWS_REMOVAL_PLAN.md** - Original comprehensive migration plan outlining all phases
- **AWS_REMOVAL_VERIFICATION.md** - Final verification checklist and validation

### Phase Completion Reports

- **AWS_PHASE1_COMPLETE.md** - Configuration management (Secrets Manager → .env)
- **AWS_PHASE2_COMPLETE.md** - Object storage (S3 → MinIO)
- **AWS_PHASE3_COMPLETE.md** - Database migration (DynamoDB → PostgreSQL)
- **AWS_PHASE5_CLEANUP_PLAN.md** - Code cleanup planning
- **AWS_PHASE5_COMPLETE.md** - Final cleanup completion

### Key Achievements

1. ✅ Removed all AWS SDK dependencies
2. ✅ Migrated offset storage from DynamoDB to PostgreSQL
3. ✅ Replaced SQS/Lambda with BullMQ/PM2 workers
4. ✅ Converted ECS tasks to PM2 managed processes
5. ✅ Updated all configuration to use environment variables
6. ✅ Cleaned up AWS-specific code and comments
7. ✅ Fixed pre-existing test failures
8. ✅ Achieved 100% unit test pass rate

## Current Architecture

For details on the current open-source architecture, see:
- [**Main Architecture Documentation**](../architecture/ARCHITECTURE.md)

## Infrastructure Stack

The system now runs on the following open-source components:
- **PostgreSQL 16.1** - Relational database
- **Redis 7.2** - Caching and queue backend (2 instances)
- **MinIO** - S3-compatible object storage
- **BullMQ** - Redis-based job queues
- **PM2** - Process management
- **Docker Compose** - Infrastructure orchestration
- **Node.js 22** - Application runtime

All components can be run locally, on VPS, or on dedicated hardware without any cloud dependencies.

## Migration Timeline

- **Planning Phase**: Complete architecture review and dependency mapping
- **Phase 1**: Configuration management migration
- **Phase 2**: Object storage migration (S3 → MinIO)
- **Phase 3**: Database migration (DynamoDB → PostgreSQL)
- **Phase 4**: Queue and compute migration (SQS/Lambda → BullMQ/PM2)
- **Phase 5**: Code cleanup and testing
- **Verification**: Comprehensive testing and validation
- **Completion**: All systems operational on open-source stack

---

**Status**: Migration Complete ✅
**Last Updated**: October 24, 2025
