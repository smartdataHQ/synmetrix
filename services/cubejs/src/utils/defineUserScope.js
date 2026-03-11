import buildSecurityContext from "./buildSecurityContext.js";

export const getDataSourceAccessList = (
  allMembers,
  selectedDataSourceId,
  selectedTeamId
) => {
  const dataSourceMemberRole = allMembers.find(
    (member) => member.team_id === selectedTeamId
  )?.member_roles?.[0];

  if (!dataSourceMemberRole) {
    const error = new Error(`403: member role not found`);
    error.status = 403;
    throw error;
  }

  const { access_list: accessList } = dataSourceMemberRole;
  const dataSourceAccessList =
    accessList?.config?.datasources?.[selectedDataSourceId]?.cubes;

  return {
    role: dataSourceMemberRole?.team_role,
    dataSourceAccessList,
  };
};

const defineUserScope = (
  allDataSources,
  allMembers,
  selectedDataSourceId,
  selectedBranchId,
  selectedVersionId
) => {
  const dataSource = allDataSources.find(
    (source) => source.id === selectedDataSourceId
  );

  if (!dataSource) {
    const error = new Error(`404: source "${selectedDataSourceId}" not found`);
    error.status = 404;
    throw error;
  }

  let selectedBranch;
  let selectedVersion;

  if (selectedBranchId) {
    const branch = dataSource.branches.find(
      (branch) => branch.id === selectedBranchId
    );

    if (!branch) {
      const error = new Error(`404: branch "${selectedBranchId}" not found`);
      error.status = 404;
      throw error;
    }

    selectedBranch = branch;
  } else {
    const defaultBranch = dataSource.branches.find(
      (branch) => branch.status === "active"
    );

    if (!defaultBranch) {
      const error = new Error(`400: default branch not found`);
      error.status = 400;
      throw error;
    }

    selectedBranch = defaultBranch;
  }

  if (selectedVersionId) {
    const version = selectedBranch.versions.find(
      (version) => version.id === selectedVersionId
    );

    if (!version) {
      const error = new Error(`404: version "${selectedVersionId}" not found`);
      error.status = 404;
      throw error;
    }

    selectedVersion = version;
  }

  const dataSourceAccessList = getDataSourceAccessList(
    allMembers,
    selectedDataSourceId,
    dataSource.team_id
  );

  // Extract team settings and member properties from the member's team
  const teamMember = allMembers.find(
    (member) => member.team_id === dataSource.team_id
  );
  const teamSettings = teamMember?.team?.settings || {};
  const memberProperties = teamMember?.properties || {};

  const dataSourceContext = buildSecurityContext(
    dataSource,
    selectedBranch,
    selectedVersion,
    teamSettings
  );

  return {
    dataSource: dataSourceContext,
    ...dataSourceAccessList,
    teamProperties: teamSettings,
    memberProperties,
  };
};

export default defineUserScope;
